import { db, env, getSettings } from "@/lib/db";
import { analyzeMoment, captionsForBeats, describeFrame, transcribe } from "@/lib/ai";
import type { MomentBeat, MomentInput, SpokenSegment } from "@/lib/ai";
import { isIngestAuthorized, json, readJson } from "@/lib/api";
import type { SpikeFeatures } from "@/lib/spike";
import type { Channel, Clip, Spike } from "@/lib/types";

export const dynamic = "force-dynamic";

interface AnalyzeBody {
  /** base64 JPEG frames sampled from the footage */
  frames?: string[];
  /** base64 16kHz mono WAV of the moment */
  audioBase64?: string;
  /** optional pre-existing transcript */
  transcript?: string;
  /** start of the sampled footage, relative to the spike peak */
  windowStartSec?: number;
  /** dBFS per bucket across the sampled footage */
  loudness?: number[];
  loudnessBucketSec?: number;
}

const MAX_FRAMES = 3;
const MAX_AUDIO_CHARS = 6_000_000; // ~4.5 MB base64

/**
 * Runs the multimodal assessment for one spike and, if it clears the quality
 * floor, creates a clip job for the renderer. Visual frames and audio come from
 * the renderer because only it has ffmpeg.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);
  const { id } = await ctx.params;

  try {
    const d = await db();
    const e = await env();
    const settings = await getSettings();

    const spike = await d.prepare("SELECT * FROM spikes WHERE id = ?").bind(id).first<Spike>();
    if (!spike) return json({ error: "spike not found" }, 404);

    const channel = await d
      .prepare("SELECT * FROM channels WHERE id = ?")
      .bind(spike.channel_id)
      .first<Channel>();

    const body = (await readJson<AnalyzeBody>(req)) ?? {};

    let features: SpikeFeatures;
    try {
      features = JSON.parse(spike.features_json ?? "{}") as SpikeFeatures;
    } catch {
      features = {} as SpikeFeatures;
    }
    let samples: string[] = [];
    try {
      samples = JSON.parse(spike.samples_json ?? "[]") as string[];
    } catch {
      samples = [];
    }

    // --- visual analysis -------------------------------------------------
    const visualNotes: string[] = [];
    let visionError: string | null = null;
    const frames = (body.frames ?? []).slice(0, MAX_FRAMES);
    for (const frame of frames) {
      const result = await describeFrame(
        e,
        frame,
        `Describe what is happening on screen in this Twitch stream frame in one short sentence. ` +
          `Focus on: reactions, deaths/eliminations, victories, sudden scene changes, on-screen text. ` +
          `Game context: ${channel?.game_name ?? "unknown"}.`,
      );
      if (result?.text) visualNotes.push(result.text.trim().slice(0, 300));
      else if (result?.error && !visionError) visionError = result.error;
    }

    // --- audio transcription --------------------------------------------
    let transcript = body.transcript ?? "";
    let sttProvider = "none";
    let sttError: string | null = null;
    let segments: SpokenSegment[] = [];
    if (!transcript && body.audioBase64 && body.audioBase64.length < MAX_AUDIO_CHARS) {
      const stt = await transcribe(e, body.audioBase64);
      if (stt?.text) {
        transcript = stt.text;
        sttProvider = stt.provider;
        segments = stt.segments;
      } else if (stt?.error) {
        // Recorded instead of swallowed: no transcript means no spoken
        // subtitles, and the operator should be able to see why.
        sttError = stt.error;
      }
    }

    await d.prepare("UPDATE spikes SET status = 'analyzing' WHERE id = ?").bind(id).run();

    const windowStartSec = Math.max(-30, Math.min(0, Number(body.windowStartSec) || 0));
    const loudnessBucketSec = Math.max(0.2, Math.min(2, Number(body.loudnessBucketSec) || 0.5));
    const loudness = (body.loudness ?? [])
      .slice(0, 200)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    const maxClipSec = Math.max(8, Math.min(60, settings.clipDurationSec));

    const input: MomentInput = {
      channelName: channel?.display_name ?? spike.channel_login,
      gameName: channel?.game_name ?? null,
      streamTitle: channel?.title ?? null,
      ts: spike.ts_unix,
      features,
      messages: samples,
      visualNotes,
      transcript,
      windowStartSec,
      loudness,
      loudnessBucketSec,
      transcriptSegments: segments,
      maxClipSec,
    };

    const analysis = await analyzeMoment(e, input);

    // --- beat plan -------------------------------------------------------
    // The model's transcript picks win: cut around the lines it judged funniest
    // for a gaming audience. The audio plan is the fallback when it picked
    // nothing usable.
    const sampledSec = loudness.length ? loudness.length * loudnessBucketSec : 30;
    const windowEndSec = windowStartSec + Math.max(10, sampledSec);
    const picked = (analysis.funnySegmentIndices ?? [])
      .slice(0, 3)
      .map((index, rank) => {
        const segment = segments[index];
        if (!segment) return null;
        const beat: MomentBeat = {
          startSec: windowStartSec + segment.startSec - 1.5,
          endSec: windowStartSec + segment.endSec + 2,
          score: 100 - rank,
        };
        return beat;
      })
      .filter((beat): beat is MomentBeat => beat !== null);

    const cleanBeats: MomentBeat[] = [];
    for (const raw of picked.length ? picked : (analysis.beats ?? [])) {
      const start = Number(raw.startSec);
      const end = Number(raw.endSec);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      // A model pick can be late in the window; do not drag it back to the
      // spike, or the cut stops containing the line that was chosen.
      const from = Math.max(windowStartSec, start);
      const to = Math.max(from + 3, Math.min(windowEndSec, end));
      if (to - from < 3) continue;
      cleanBeats.push({ startSec: from, endSec: to, score: Number(raw.score) || 0 });
    }
    cleanBeats.sort((a, b) => a.startSec - b.startSec);

    const mergedBeats: MomentBeat[] = [];
    for (const beat of cleanBeats) {
      const previous = mergedBeats[mergedBeats.length - 1];
      if (previous && beat.startSec <= previous.endSec + 0.4) {
        previous.endSec = Math.max(previous.endSec, beat.endSec);
      } else {
        mergedBeats.push({ ...beat });
      }
    }

    while (
      mergedBeats.length > 1 &&
      mergedBeats.reduce((sum, b) => sum + (b.endSec - b.startSec), 0) > maxClipSec
    ) {
      const weakest = mergedBeats.reduce((a, b) => (b.score < a.score ? b : a));
      mergedBeats.splice(mergedBeats.indexOf(weakest), 1);
    }

    let beats = mergedBeats;
    if (!beats.length) {
      const from = Math.max(windowStartSec, Math.min(4, analysis.beginsAtSec));
      beats = [
        {
          startSec: from,
          endSec: Math.max(from + 6, Math.min(windowEndSec, analysis.endsAtSec)),
          score: 50,
        },
      ];
    }
    if (beats.length === 1 && beats[0].endSec - beats[0].startSec < 6) {
      beats[0] = { ...beats[0], endSec: Math.min(windowEndSec, beats[0].startSec + 6) };
    }

    const assembledSec = beats.reduce((sum, b) => sum + (b.endSec - b.startSec), 0);
    analysis.beginsAtSec = beats[0].startSec;
    analysis.endsAtSec = beats[beats.length - 1].endSec;
    analysis.beats = beats;
    const captions = captionsForBeats(segments, windowStartSec, beats);

    await d
      .prepare("UPDATE spikes SET ai_json = ?, ai_provider = ?, status = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...analysis,
          visualNotes,
          transcript,
          transcriptSegments: segments,
          captions,
          windowStartSec,
          sttProvider,
          sttError,
          visionError,
        }),
        analysis.provider,
        analysis.qualityScore >= settings.minQualityScore ? "rendering" : "skipped",
        id,
      )
      .run();

    // The score is the judgement; the model's separate `interesting` opinion is
    // not consulted, because it regularly contradicts the score it just gave
    // and silently threw away passing moments.
    if (analysis.qualityScore < settings.minQualityScore) {
      return json({
        ok: true,
        skipped: true,
        reason: `quality ${analysis.qualityScore} below floor ${settings.minQualityScore}`,
        analysis,
        transcript,
        sttError,
      });
    }

    // Reuse an existing clip job for this spike rather than creating duplicates.
    const existing = await d
      .prepare("SELECT id FROM clips WHERE spike_id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (existing) {
      return json({ ok: true, clipId: existing.id, analysis, existing: true, beats, captions, sttError });
    }

    const clipId = crypto.randomUUID();
    const now = new Date().toISOString();
    // The duration setting is the ceiling, not the target: the joined cuts are
    // as long as the beats are, never padded to fill it.
    const beginsAt = beats[0].startSec;
    const durationSec = Math.max(6, Math.min(maxClipSec, assembledSec));
    const startOffset = Math.max(0, spike.ts_unix + beginsAt);
    const endOffset = startOffset + durationSec;

    await d
      .prepare(
        `INSERT INTO clips
          (id, spike_id, channel_id, channel_login, channel_name, title, caption, description,
           hashtags_json, game_name, stream_title, quality_score, funniness, intensity, category,
           duration_ms, width, height, r2_key, thumb_key, bytes, status, error, provider, model,
           source_ts, start_offset, end_offset, transcript, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
                 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        clipId,
        spike.id,
        spike.channel_id,
        spike.channel_login,
        channel?.display_name ?? spike.channel_login,
        analysis.title,
        analysis.caption,
        analysis.summary,
        JSON.stringify(analysis.hashtags),
        channel?.game_name ?? null,
        channel?.title ?? null,
        analysis.qualityScore,
        analysis.funniness,
        spike.intensity,
        analysis.category,
        Math.round(durationSec * 1000),
        settings.aspectRatio === "9:16" ? 1080 : settings.aspectRatio === "1:1" ? 1080 : 1920,
        settings.aspectRatio === "9:16" ? 1920 : settings.aspectRatio === "1:1" ? 1080 : 1080,
        analysis.provider,
        analysis.model,
        spike.ts_unix,
        startOffset,
        endOffset,
        transcript || null,
        now,
        now,
      )
      .run();

    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(clipId).first<Clip>();
    return json({ ok: true, clipId, clip, analysis, transcript, beats, captions, sttError });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

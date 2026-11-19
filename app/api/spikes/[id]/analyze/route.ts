import { db, ensureClipStateColumns, ensureWebcamColumn, env, getSettings } from "@/lib/db";
import {
  analyzeMoment,
  captionsForBeats,
  describeFrame,
  detectWebcam,
  loudnessContrast,
  transcribe,
} from "@/lib/ai";
import { boxFromHint, storedWebcam, type WebcamHint } from "@/lib/webcam";
import { pollSignals } from "@/lib/poll";
import { pickUnused, uniqueCaption, uniqueTitle } from "@/lib/titles";
import { chatAdShare, chatLooksLikeAd, looksLikeAdFrame } from "@/lib/ads";
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
    await ensureWebcamColumn(d);
    await ensureClipStateColumns(d);

    const spike = await d.prepare("SELECT * FROM spikes WHERE id = ?").bind(id).first<Spike>();
    if (!spike) return json({ error: "spike not found" }, 404);

    // A single-clip rebuild stores the settings it should use on the spike, so
    // the re-cut honours the suggestion without changing the saved defaults.
    let override: {
      clipDurationSec?: number;
      minQualityScore?: number;
      longer?: boolean;
      needsContext?: boolean;
      webcamRegion?: string;
      title?: string;
      caption?: string;
      direction?: string;
    } = {};
    try {
      override = JSON.parse(spike.analyze_json ?? "{}") as typeof override;
    } catch {
      override = {};
    }
    const overrideDuration = Number(override.clipDurationSec);
    const overrideFloor = Number(override.minQualityScore);
    const effectiveDuration = Number.isFinite(overrideDuration)
      ? Math.max(6, Math.min(60, overrideDuration))
      : settings.clipDurationSec;
    const effectiveFloor = Number.isFinite(overrideFloor)
      ? Math.max(0, Math.min(95, overrideFloor))
      : settings.minQualityScore;
    // A per-clip re-cut can ask for a longer cut and for the setup around the
    // moment, not just a bigger duration ceiling.
    const longer = override.longer === true;
    const needsContext = override.needsContext === true;
    const extraSec = needsContext ? 12 : longer ? 8 : 0;

    const channel = await d
      .prepare("SELECT * FROM channels WHERE id = ?")
      .bind(spike.channel_id)
      .first<Channel>();

    // A rebuild keeps the clip row, so its own title must not count as taken.
    const existing = await d
      .prepare("SELECT id, webcam_json FROM clips WHERE spike_id = ?")
      .bind(id)
      .first<{ id: string; webcam_json: string | null }>();
    // Titles and captions are both checked against the store: two clips can be
    // different moments and still look like the same upload if they share copy.
    const copyRows =
      (
        await d
          .prepare("SELECT id, title, caption FROM clips ORDER BY created_at DESC LIMIT 1000")
          .all<{ id: string; title: string | null; caption: string | null }>()
      ).results ?? [];
    const elsewhere = copyRows.filter((row) => row.id !== existing?.id);
    const takenTitles = elsewhere.map((row) => row.title ?? "").filter(Boolean);
    const takenCaptions = elsewhere.map((row) => row.caption ?? "").filter(Boolean);

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
    // Polls and command votes spike chat volume too; the content decides
    // whether there is anything worth clipping.
    const poll = pollSignals(samples);

    // --- visual analysis -------------------------------------------------
    const visualNotes: string[] = [];
    const frameNotes: string[] = [];
    let visionError: string | null = null;
    const frames = (body.frames ?? []).slice(0, MAX_FRAMES);
    for (const frame of frames) {
      const result = await describeFrame(
        e,
        frame,
        `Describe what is happening on screen in this Twitch stream frame in one short sentence. ` +
          `Focus on: reactions, deaths/eliminations, victories, sudden scene changes, on-screen text. ` +
          `Say so plainly if this is an advertisement, an ad countdown, a "stream will continue shortly" ` +
          `screen or a technical pause instead of the stream. ` +
          `Game context: ${channel?.game_name ?? "unknown"}.`,
      );
      if (result?.text) {
        const note = result.text.trim().slice(0, 300);
        frameNotes.push(note);
        visualNotes.push(note);
      } else if (result?.error && !visionError) visionError = result.error;
    }

    // An ad break has every ingredient of a good moment - a chat burst, a loud
    // cut - except anything happening on stream, so the clip is of the ad page.
    // Both signals here are free: what the frames describe, and what chat says.
    const adFrames = frameNotes.filter((note) => looksLikeAdFrame(note)).length;
    const adChatShare = Math.round(chatAdShare(samples) * 100) / 100;
    const adReason =
      frameNotes.length > 0 && adFrames === frameNotes.length
        ? "every sampled frame was an ad break, not the stream"
        : chatLooksLikeAd(samples)
          ? "chat was calling out an ad break"
          : null;
    if (adReason) {
      await d
        .prepare("UPDATE spikes SET ai_json = ?, status = 'skipped' WHERE id = ?")
        .bind(JSON.stringify({ skipped: adReason, adFrames, adChatShare }), id)
        .run();
      return json({ ok: true, skipped: true, reason: adReason, adFrames, transcript: "" });
    }

    // --- webcam layout ---------------------------------------------------
    // One extra vision call per clip. If the model is unsure, the clip keeps
    // the normal layout rather than guessing a crop.
    let webcamJson: string | null = null;
    const manualRegion =
      typeof override.webcamRegion === "string" ? override.webcamRegion : "";
    const manualHint: WebcamHint | null =
      manualRegion && manualRegion !== "none"
        ? { visible: true, region: manualRegion, size: "medium" }
        : null;
    const manualBox = boxFromHint(manualHint);

    if (manualRegion === "none") {
      // The streamer has no face cam, or the operator never wants one here.
      webcamJson = null;
    } else if (manualHint && manualBox) {
      webcamJson = storedWebcam(manualHint, manualBox);
    } else if (frames.length > 0) {
      const context = `Game: ${channel?.game_name ?? "unknown"}. Channel: ${channel?.display_name ?? spike.channel_login}.`;
      // Detection runs even when enlargement is switched off, so the clip keeps
      // the placement for later. Every sampled frame gets a chance: one frame
      // can be a fullscreen cutscene that hides the cam entirely.
      let hint: WebcamHint | null = null;
      for (const frame of frames.slice(0, 3)) {
        hint = await detectWebcam(e, frame, context);
        if (hint) break;
      }
      const box = boxFromHint(hint);
      if (hint && box) webcamJson = storedWebcam(hint, box);
    }
    // A re-cut whose detection failed must not throw away a placement the clip
    // already had; without this, reprocessing could remove the enlargement.
    if (!webcamJson && manualRegion !== "none") {
      webcamJson = existing?.webcam_json ?? null;
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

    // Older agents do not send this. Their sampled audio starts fifteen seconds
    // before the spike, which is a better default than 0.
    const windowStartSec =
      body.windowStartSec === undefined
        ? -15
        : Math.max(-30, Math.min(0, Number(body.windowStartSec) || 0));
    const loudnessBucketSec = Math.max(0.2, Math.min(2, Number(body.loudnessBucketSec) || 0.5));
    const loudness = (body.loudness ?? [])
      .slice(0, 200)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    const maxClipSec = Math.max(8, Math.min(60, effectiveDuration + extraSec));

    // A per-clip re-cut can carry the operator's own words and copy. The typed
    // direction goes first so a long standing direction cannot truncate it.
    const typedDirection = typeof override.direction === "string" ? override.direction.trim() : "";
    const keptTitle = typeof override.title === "string" ? override.title.trim().slice(0, 120) : "";
    const keptCaption =
      typeof override.caption === "string" ? override.caption.trim().slice(0, 120) : "";
    const copyGuidance = [
      keptTitle ? `The operator already wrote the title: "${keptTitle}". Do not contradict it.` : "",
      keptCaption ? `The operator already wrote the caption: "${keptCaption}". Do not contradict it.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const direction = [typedDirection, copyGuidance, settings.clipDirection]
      .filter(Boolean)
      .join(" ");

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
      direction,
      pollHint: poll.likely ? poll.reason : undefined,
      contextHint: needsContext,
      avoidTitles: takenTitles.slice(0, 40),
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

    // A vote is not a moment. Keep it only when the footage reacted: a spoken
    // reaction, a loud beat, or a moment the model still scored highly.
    if (poll.likely && picked.length === 0) {
      const spokenReaction =
        /(haha|laugh|lmao|lol|bruh|no way|what the|oh my god|are you serious|screaming|dying)/i.test(
          transcript,
        );
      const audibleReaction = loudnessContrast(loudness, loudnessBucketSec, windowStartSec) >= 5;
      const scored = analysis.qualityScore >= effectiveFloor || analysis.funniness >= 65;
      if (!spokenReaction && !audibleReaction && !scored) {
        await d
          .prepare("UPDATE spikes SET ai_json = ?, ai_provider = ?, status = 'skipped' WHERE id = ?")
          .bind(JSON.stringify({ ...analysis, poll }), analysis.provider, id)
          .run();
        return json({
          ok: true,
          skipped: true,
          reason: `poll responses (${Math.round(poll.share * 100)}% "${poll.top}") with no reaction on stream`,
          analysis,
          transcript,
          sttError,
        });
      }
    }

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
    // Widening the cuts is what makes a re-cut longer or fuller-context; a
    // larger duration ceiling on its own would not add a single frame.
    if (longer || needsContext) {
      const pad = needsContext ? 3 : 2;
      beats = beats
        .map((beat) => ({
          ...beat,
          startSec: Math.max(windowStartSec, beat.startSec - pad),
          endSec: Math.min(windowEndSec, beat.endSec + pad),
        }))
        .reduce<MomentBeat[]>((out, beat) => {
          const previous = out[out.length - 1];
          if (previous && beat.startSec <= previous.endSec + 0.4) {
            previous.endSec = Math.max(previous.endSec, beat.endSec);
          } else {
            out.push({ ...beat });
          }
          return out;
        }, []);
    }
    if (beats.length === 1 && beats[0].endSec - beats[0].startSec < 6) {
      beats[0] = { ...beats[0], endSec: Math.min(windowEndSec, beats[0].startSec + 6) };
    }

    // A used title used to become "the same phrase (2)" forever. The model's own
    // three options and the line that was actually picked are tried first, so a
    // clip is named after its own moment instead of a numbered copy.
    const spokenLine = (analysis.funnySegmentIndices ?? [])
      .map((index) => segments[index]?.text)
      .find((text) => typeof text === "string" && text.trim().length > 8);
    const quote = (spokenLine ?? "")
      .replace(/\s+/g, " ")
      .replace(/["'“”]/g, "")
      .trim()
      .slice(0, 68);
    const titleCandidates = [
      ...(analysis.titleOptions ?? []),
      analysis.title,
      quote,
      quote ? `${quote} — ${channel?.game_name ?? analysis.category}` : "",
      `${analysis.title} — ${channel?.game_name ?? analysis.category}`,
      `${analysis.title} — ${analysis.category}`,
      `${analysis.title} · ${channel?.display_name ?? spike.channel_login}`,
    ].filter((value): value is string => Boolean(value));
    analysis.title =
      pickUnused(titleCandidates, takenTitles) ??
      uniqueTitle(analysis.title, takenTitles, titleCandidates);
    // The caption has to be its own line of copy: not the title, not another
    // clip's caption.
    analysis.caption = uniqueCaption(analysis.caption, takenCaptions, analysis.title, [
      `${analysis.caption} — ${channel?.game_name ?? analysis.category}`.slice(0, 90).toUpperCase(),
      `${analysis.caption} — ${channel?.display_name ?? spike.channel_login}`.slice(0, 90).toUpperCase(),
    ]);
    // Copy the operator typed in the modal wins over the model's, still checked
    // for uniqueness so a hand-written title cannot collide with another clip.
    if (keptTitle) {
      analysis.title = uniqueTitle(keptTitle, takenTitles, [
        `${keptTitle} — ${channel?.game_name ?? analysis.category}`,
      ]);
    }
    if (keptCaption) {
      analysis.caption = uniqueCaption(keptCaption, takenCaptions, analysis.title, [
        `${keptCaption} — ${channel?.game_name ?? analysis.category}`.slice(0, 90).toUpperCase(),
      ]);
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
          poll,
        }),
        analysis.provider,
        analysis.qualityScore >= effectiveFloor ? "rendering" : "skipped",
        id,
      )
      .run();

    // The score is the judgement; the model's separate `interesting` opinion is
    // not consulted, because it regularly contradicts the score it just gave
    // and silently threw away passing moments.
    const now = new Date().toISOString();
    // The duration setting is the ceiling, not the target: the joined cuts are
    // as long as the beats are, never padded to fill it.
    const beginsAt = beats[0].startSec;
    const durationSec = Math.max(6, Math.min(maxClipSec, assembledSec));
    const startOffset = Math.max(0, spike.ts_unix + beginsAt);
    const endOffset = startOffset + durationSec;
    const outWidth =
      settings.aspectRatio === "9:16" ? 1080 : settings.aspectRatio === "1:1" ? 1080 : 1920;
    const outHeight =
      settings.aspectRatio === "9:16" ? 1920 : settings.aspectRatio === "1:1" ? 1080 : 1080;

    if (analysis.qualityScore < effectiveFloor) {
      const stale = await d
        .prepare("SELECT id, r2_key FROM clips WHERE spike_id = ?")
        .bind(id)
        .first<{ id: string; r2_key: string | null }>();
      if (stale && !stale.r2_key) {
        await d
          .prepare("UPDATE clips SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
          .bind(
            `re-analysis scored ${analysis.qualityScore}, below floor ${effectiveFloor}`,
            now,
            stale.id,
          )
          .run();
      } else if (stale) {
        // A re-cut that scored below the floor keeps the cut that already
        // exists instead of replacing it with a failed, empty clip.
        await d
          .prepare("UPDATE clips SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?")
          .bind(now, stale.id)
          .run();
      }
      await d.prepare("UPDATE spikes SET analyze_json = NULL WHERE id = ?").bind(id).run();
      return json({
        ok: true,
        skipped: true,
        reason: `quality ${analysis.qualityScore} below floor ${effectiveFloor}`,
        analysis,
        transcript,
        sttError,
      });
    }

    // Reuse the clip job for this spike rather than creating duplicates. On a
    // rebuild this replaces the stored metadata and hands the clip back to the
    // renderer with the freshly picked beats.
    if (existing) {
      await d
        .prepare(
          `UPDATE clips SET title = ?, caption = ?, description = ?, hashtags_json = ?,
             quality_score = ?, funniness = ?, category = ?, duration_ms = ?, width = ?, height = ?,
             provider = ?, model = ?, start_offset = ?, end_offset = ?, transcript = ?,
             webcam_json = ?,
             -- The new cut is a different video: it counts as recently re-cut and
             -- has not been watched yet, so its ready badge comes back.
             recut_at = ?, watched_at = NULL,
             -- The current video stays playable until the new one is uploaded:
             -- clearing it here is what made a re-cut look like a deleted clip.
             status = 'pending', error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          analysis.title,
          analysis.caption,
          analysis.summary,
          JSON.stringify(analysis.hashtags),
          analysis.qualityScore,
          analysis.funniness,
          analysis.category,
          Math.round(durationSec * 1000),
          outWidth,
          outHeight,
          analysis.provider,
          analysis.model,
          startOffset,
          endOffset,
          transcript || null,
          webcamJson,
          now,
          now,
          existing.id,
        )
        .run();
      await d.prepare("UPDATE spikes SET analyze_json = NULL WHERE id = ?").bind(id).run();
      return json({ ok: true, clipId: existing.id, analysis, existing: true, beats, captions, sttError });
    }

    const clipId = crypto.randomUUID();

    await d
      .prepare(
        `INSERT INTO clips
          (id, spike_id, channel_id, channel_login, channel_name, title, caption, description,
           hashtags_json, game_name, stream_title, quality_score, funniness, intensity, category,
           duration_ms, width, height, r2_key, thumb_key, bytes, status, error, provider, model,
           source_ts, start_offset, end_offset, transcript, webcam_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
                 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        outWidth,
        outHeight,
        analysis.provider,
        analysis.model,
        spike.ts_unix,
        startOffset,
        endOffset,
        transcript || null,
        webcamJson,
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

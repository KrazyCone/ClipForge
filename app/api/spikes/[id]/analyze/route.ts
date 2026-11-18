import { db, env, getSettings } from "@/lib/db";
import { analyzeMoment, describeFrame, transcribe } from "@/lib/ai";
import type { MomentInput } from "@/lib/ai";
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
    if (!transcript && body.audioBase64 && body.audioBase64.length < MAX_AUDIO_CHARS) {
      const binary = Uint8Array.from(atob(body.audioBase64), (c) => c.charCodeAt(0));
      const stt = await transcribe(e, binary.buffer);
      if (stt?.text) {
        transcript = stt.text;
        sttProvider = stt.provider;
      }
    }

    await d.prepare("UPDATE spikes SET status = 'analyzing' WHERE id = ?").bind(id).run();

    const input: MomentInput = {
      channelName: channel?.display_name ?? spike.channel_login,
      gameName: channel?.game_name ?? null,
      streamTitle: channel?.title ?? null,
      ts: spike.ts_unix,
      features,
      messages: samples,
      visualNotes,
      transcript,
    };

    const analysis = await analyzeMoment(e, input);

    await d
      .prepare("UPDATE spikes SET ai_json = ?, ai_provider = ?, status = ? WHERE id = ?")
      .bind(
        JSON.stringify({ ...analysis, visualNotes, transcript, sttProvider, visionError }),
        analysis.provider,
        analysis.qualityScore >= settings.minQualityScore ? "rendering" : "skipped",
        id,
      )
      .run();

    if (analysis.qualityScore < settings.minQualityScore || !analysis.interesting) {
      return json({
        ok: true,
        skipped: true,
        reason: `quality ${analysis.qualityScore} below floor ${settings.minQualityScore}`,
        analysis,
        transcript,
      });
    }

    // Reuse an existing clip job for this spike rather than creating duplicates.
    const existing = await d
      .prepare("SELECT id FROM clips WHERE spike_id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (existing) {
      return json({ ok: true, clipId: existing.id, analysis, existing: true });
    }

    const clipId = crypto.randomUUID();
    const now = new Date().toISOString();
    const startOffset = Math.max(0, spike.ts_unix - settings.preEventSec);
    const durationSec = Math.min(
      settings.clipDurationSec,
      Math.max(8, analysis.endsAtSec - analysis.beginsAtSec || settings.clipDurationSec),
    );

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
        startOffset + durationSec,
        transcript || null,
        now,
        now,
      )
      .run();

    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(clipId).first<Clip>();
    return json({ ok: true, clipId, clip, analysis, transcript });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

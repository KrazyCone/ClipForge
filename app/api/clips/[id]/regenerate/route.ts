import { db, env, getSettings } from "@/lib/db";
import { regenerateCopy } from "@/lib/ai";
import type { MomentInput } from "@/lib/ai";
import { uniqueCaption, uniqueTitle } from "@/lib/titles";
import type { SpikeFeatures } from "@/lib/spike";
import { json } from "@/lib/api";
import type { Clip, Spike } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const d = await db();
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
    if (!clip) return json({ error: "clip not found" }, 404);

    const spike = clip.spike_id
      ? await d.prepare("SELECT * FROM spikes WHERE id = ?").bind(clip.spike_id).first<Spike>()
      : null;

    let features: SpikeFeatures;
    try {
      features = JSON.parse(spike?.features_json ?? "{}") as SpikeFeatures;
    } catch {
      features = {} as SpikeFeatures;
    }

    const input: MomentInput = {
      channelName: clip.channel_name ?? "streamer",
      gameName: clip.game_name,
      streamTitle: clip.stream_title,
      ts: clip.source_ts ?? Math.floor(Date.now() / 1000),
      features: {
        peakRate: features.peakRate ?? 0,
        baselineRate: features.baselineRate ?? 0,
        zScore: features.zScore ?? 0,
        ratio: features.ratio ?? 1,
        uniqueChatters: features.uniqueChatters ?? 0,
        chatterDiversity: features.chatterDiversity ?? 0,
        emoteRatio: features.emoteRatio ?? 0,
        repeatRatio: features.repeatRatio ?? 0,
        laughRatio: features.laughRatio ?? 0,
        capsRatio: features.capsRatio ?? 0,
        burstiness: features.burstiness ?? 0,
        acceleration: features.acceleration ?? 1,
        messageCount: features.messageCount ?? 0,
        burstStart: features.burstStart ?? 0,
        burstEnd: features.burstEnd ?? 0,
      },
      messages: [],
    };

    const e = await env();
    const settings = await getSettings();

    // Everything this clip must not repeat: other clips' copy. Its own current
    // title and caption are passed as the "previous" pair instead.
    const rows =
      (
        await d
          .prepare("SELECT id, title, caption FROM clips WHERE id != ? ORDER BY created_at DESC LIMIT 1000")
          .bind(id)
          .all<{ id: string; title: string | null; caption: string | null }>()
      ).results ?? [];
    const takenTitles = rows.map((row) => row.title ?? "").filter(Boolean);
    const takenCaptions = rows.map((row) => row.caption ?? "").filter(Boolean);

    const generated = await regenerateCopy(
      e,
      input,
      { title: clip.title ?? "", caption: clip.caption ?? "" },
      {
        avoidTitles: takenTitles,
        avoidCaptions: takenCaptions,
        direction: settings.clipDirection,
      },
    );

    // The model is asked to be original; these two are the guarantee.
    const title = uniqueTitle(generated.title, takenTitles, [
      `${generated.title} — ${clip.game_name ?? clip.channel_name ?? "twitch"}`,
    ]);
    const caption = uniqueCaption(generated.caption, takenCaptions, title, [
      `${generated.caption} — ${clip.game_name ?? clip.channel_name ?? "LIVE"}`.slice(0, 90),
    ]);

    await d
      .prepare("UPDATE clips SET title = ?, caption = ?, updated_at = ? WHERE id = ?")
      .bind(title, caption, new Date().toISOString(), id)
      .run();

    return json({ title, caption, provider: generated.provider });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

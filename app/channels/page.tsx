import { getSettings } from "@/lib/db";
import { getAllChannels, getActivitySeries, getRecentSpikes } from "@/lib/queries";
import { getSystemStatus } from "@/lib/status";
import { ChannelManager } from "@/components/ChannelManager";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const [channels, settings, status] = await Promise.all([
    getAllChannels(),
    getSettings(),
    getSystemStatus(),
  ]);
  const [series, spikes] = await Promise.all([
    getActivitySeries(channels.map((c) => c.id), 30),
    getRecentSpikes(60),
  ]);

  const spikeCounts: Record<string, number> = {};
  for (const s of spikes) spikeCounts[s.channel_id] = (spikeCounts[s.channel_id] ?? 0) + 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Channels</h1>
          <p className="page-desc">
            Twitch channels ClipForge watches. Each monitored channel consumes one collector
            slot and roughly 1,440 D1 writes per day.
          </p>
        </div>
        <span className="badge">
          {channels.filter((c) => c.monitor === 1).length} / {settings.maxChannels} slots
        </span>
      </div>

      <ChannelManager
        channels={channels}
        series={series}
        spikeCounts={spikeCounts}
        maxChannels={settings.maxChannels}
        twitchReady={status.twitch}
        discoveryEnabled={settings.discoveryEnabled}
      />
    </>
  );
}

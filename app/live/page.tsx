import Link from "next/link";
import { Sparkline } from "@/components/Sparkline";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Avatar, Badge, Empty, Score, ago } from "@/components/ui";
import { IconAlert, IconFilm, IconPulse, IconRadio, IconSparkle } from "@/components/icons";
import {
  getActivitySeries,
  getChannels,
  getChatSamples,
  getRecentSpikes,
} from "@/lib/queries";
import { RefreshLiveButton } from "@/components/RefreshLiveButton";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const channels = await getChannels();
  const live = channels.filter((c) => c.is_live);

  const [series, samples, spikes] = await Promise.all([
    getActivitySeries(channels.map((c) => c.id), 20),
    Promise.all(channels.map((c) => getChatSamples(c.id, 12))),
    getRecentSpikes(14),
  ]);

  const samplesByChannel = new Map(channels.map((c, i) => [c.id, samples[i]]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Live monitor</h1>
          <p className="page-desc">
            Chat velocity per channel, the spikes the detector fired, and the messages that
            triggered them. Updates automatically.
          </p>
        </div>
        <div className="row">
          <AutoRefresh intervalMs={15000} />
          <RefreshLiveButton />
        </div>
      </div>

      {channels.length === 0 ? (
        <div className="panel">
          <Empty
            icon={<IconRadio />}
            title="Nothing is being monitored"
            action={
              <Link className="btn primary sm" href="/channels">
                Add a channel
              </Link>
            }
          >
            The live monitor shows channels you have added. Start with one to see the
            detector work.
          </Empty>
        </div>
      ) : live.length === 0 ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-body">
            <div className="row" style={{ gap: 10 }}>
              <div className="empty-icon" style={{ margin: 0 }}>
                <IconAlert width={16} height={16} />
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {channels.length} channel{channels.length === 1 ? "" : "s"} monitored, none live
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  Chat spikes can only be detected while a stream is live. Live status refreshes
                  every 30 seconds from the Twitch API.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="live-grid" style={{ marginBottom: 16 }}>
        {channels.map((c) => {
          const s = series[c.id] ?? [];
          const recent = spikes.filter((sp) => sp.channel_id === c.id).slice(0, 3);
          const chat = samplesByChannel.get(c.id);
          const peak = s.length ? Math.max(...s) : 0;
          const lastSpike = recent[0];

          return (
            <article key={c.id} className="channel-card">
              <div className="channel-card-head">
                <Avatar src={c.avatar_url} name={c.display_name} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }} className="truncate">
                      {c.display_name}
                    </span>
                    {c.is_live ? <Badge tone="live" dot>live</Badge> : <Badge>offline</Badge>}
                    {/* A live channel with no chat rows at all is not a quiet
                        chat, it is a channel the collector is not receiving. */}
                    {c.is_live && (!chat || Date.now() / 1000 - chat.ts > 600) ? (
                      <Badge tone="amber">no chat</Badge>
                    ) : null}
                  </div>
                  <div className="faint truncate" style={{ fontSize: 11 }}>
                    {c.game_name ?? "No category"}
                    {c.viewer_count ? ` · ${c.viewer_count.toLocaleString()} viewers` : ""}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>
                    {peak}
                  </div>
                  <div className="faint" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    peak msg/s
                  </div>
                </div>
              </div>

              <div style={{ padding: "0 0 6px" }}>
                <Sparkline
                  data={s.length ? s : [0, 0, 0, 0, 0, 0]}
                  height={52}
                  color={c.is_live ? "var(--text)" : "#3d3d44"}
                  markerIndex={s.length > 0 ? s.indexOf(peak) : undefined}
                />
              </div>

              <div className="channel-card-body">
                <div className="spread" style={{ marginBottom: 8 }}>
                  <span className="faint" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.075em" }}>
                    Recent chat
                  </span>
                  <span className="faint" style={{ fontSize: 10.5 }}>
                    {chat ? ago(chat.ts) : "no data"}
                  </span>
                </div>
                <div className="chat-box">
                  {chat?.messages.length ? (
                    chat.messages.slice(-6).map((m, i) => {
                      const [user, ...rest] = m.split(": ");
                      return (
                        <div key={i} className="chat-line truncate">
                          <b>{user}</b>: {rest.join(": ")}
                        </div>
                      );
                    })
                  ) : (
                    <div className="faint" style={{ fontSize: 11.5 }}>
                      Waiting for the collector to report messages.
                    </div>
                  )}
                </div>

                {lastSpike ? (
                  <div
                    className="spread"
                    style={{
                      marginTop: 10,
                      padding: "7px 9px",
                      background: "#1d1d20",
                      border: "1px solid #37373d",
                      borderRadius: 7,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 550 }}>
                        Spike · {lastSpike.peak_rate.toFixed(0)}/s vs {lastSpike.baseline_rate.toFixed(1)}/s
                      </div>
                      <div className="faint" style={{ fontSize: 10.5 }}>
                        {lastSpike.unique_chatters} chatters · {ago(lastSpike.ts_unix)}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 7 }}>
                      <Score value={Math.round(lastSpike.intensity)} />
                      <Badge tone={lastSpike.status === "done" ? "green" : "neutral"}>
                        {lastSpike.status}
                      </Badge>
                    </div>
                  </div>
                ) : null}

                <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
                  <Badge>{c.capture_mode === "vod" ? "vod capture" : "chat only"}</Badge>
                  <Badge>{c.moments} moments</Badge>
                  {c.last_polled_at ? <Badge>polled {ago(c.last_polled_at)}</Badge> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <IconPulse width={13} height={13} /> Detected spikes
          </h2>
          <span className="faint" style={{ fontSize: 11 }}>
            {spikes.length} recent
          </span>
        </div>
        <div className="panel-body flush">
          {spikes.length === 0 ? (
            <Empty icon={<IconSparkle />} title="No spikes yet">
              The detector compares every second of chat against that channel&apos;s own
              rolling baseline. A spike appears here the moment chat breaks pattern.
            </Empty>
          ) : (
            spikes.map((s) => (
              <div key={s.id} className="list-row">
                <div
                  style={{
                    width: 34,
                    textAlign: "center",
                    fontWeight: 700,
                    fontSize: 13,
                    color: s.intensity >= 75 ? "var(--green)" : "var(--text)",
                  }}
                >
                  {Math.round(s.intensity)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 550 }}>{s.channel_login}</span>
                    <Badge tone={s.status === "done" ? "green" : s.status === "failed" ? "red" : "neutral"}>
                      {s.status}
                    </Badge>
                  </div>
                  <div className="faint truncate" style={{ fontSize: 11 }}>
                    {s.peak_rate.toFixed(0)}/s peak vs {s.baseline_rate.toFixed(1)}/s baseline ·{" "}
                    z={s.z_score.toFixed(1)} · {s.message_count} msgs · {ago(s.ts_unix)}
                  </div>
                </div>
                <Link className="btn sm ghost" href={`/clips?spike=${s.id}`}>
                  <IconFilm width={12} height={12} />
                </Link>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

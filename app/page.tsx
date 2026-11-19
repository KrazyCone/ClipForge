import Link from "next/link";
import { Sparkline } from "@/components/Sparkline";
import { Badge, Bar, Empty, Score, Stat, ago, fmtBytes, fmtDuration } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconCpu,
  IconFilm,
  IconPulse,
  IconRadio,
  IconSparkle,
  IconX,
} from "@/components/icons";
import { getSettings } from "@/lib/db";
import {
  getActivitySeries,
  getChannels,
  getLastRun,
  getRecentClips,
  getRecentSpikes,
  getStats,
  getTopClips,
} from "@/lib/queries";
import { getSystemStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [channels, stats, settings, status] = await Promise.all([
    getChannels(),
    getStats(),
    getSettings(),
    getSystemStatus(),
  ]);

  const [series, recentClips, topClips, spikes, collectorRun] = await Promise.all([
    getActivitySeries(channels.map((c) => c.id), 20),
    getRecentClips(6),
    getTopClips(4),
    getRecentSpikes(6),
    getLastRun("collector"),
  ]);

  const storageLimitBytes = settings.storageLimitMb * 1024 * 1024;
  const storagePct = Math.min(100, (stats.storageBytes / Math.max(storageLimitBytes, 1)) * 100);
  const writePct = Math.min(100, (stats.writesToday / 10000) * 100);
  const rowsPct = Math.min(100, (stats.d1Rows / 100000) * 100);

  const setupDone = status.twitch && stats.channelCount > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Command center</h1>
          <p className="page-desc">
            Chat-driven moment detection across the streams you monitor. Clips are cut,
            scored and published without you touching anything.
          </p>
        </div>
        <div className="row">
          <Link className="btn" href="/channels">
            <IconPulse width={13} height={13} /> Channels
          </Link>
          <Link className="btn primary" href="/clips">
            <IconFilm width={13} height={13} /> Clip library
          </Link>
        </div>
      </div>

      {!setupDone ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h2 className="panel-title">
              <IconAlert width={14} height={14} /> Finish setup
            </h2>
            <Badge tone="amber">action needed</Badge>
          </div>
          <div className="panel-body">
            <SetupStep
              done={status.d1 && status.r2}
              title="Cloudflare D1 + R2 bindings"
              detail="Database and clip storage are attached to this deployment."
            />
            <SetupStep
              done={status.twitch}
              title="Twitch API credentials"
              detail="Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET as project secrets, then redeploy."
              href="https://dev.twitch.tv/console/apps"
            />
            <SetupStep
              done={status.ingestToken}
              title="Collector token"
              detail="Set INGEST_TOKEN so the chat collector and renderer can authenticate."
            />
            <SetupStep
              done={stats.channelCount > 0}
              title="Add a channel"
              detail="Pick a channel to monitor from the Channels page."
              href="/channels"
            />
            <p className="faint" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
              Setup details and the free-tier architecture are in ARCHITECTURE.md in the repository.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label="Clips generated"
          value={stats.clips}
          icon={<IconFilm width={12} height={12} />}
          foot={`${stats.readyClips} ready · ${stats.queueDepth} processing`}
        />
        <Stat
          label="Chat spikes today"
          value={stats.spikesToday}
          icon={<IconPulse width={12} height={12} />}
          foot={`${stats.spikesTotal} all time`}
        />
        <Stat
          label="Live channels"
          value={stats.liveChannels}
          icon={<IconRadio width={12} height={12} />}
          foot={`${stats.channelCount} monitored`}
        />
        <Stat
          label="Avg quality"
          value={stats.avgQuality ?? "—"}
          icon={<IconSparkle width={12} height={12} />}
          foot={settings.minQualityScore ? `floor ${settings.minQualityScore}` : "no floor"}
        />
      </div>

      <div className="grid grid-2-1" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconRadio width={13} height={13} /> Monitored streams
            </h2>
            <Link className="btn sm ghost" href="/live">
              Live monitor
            </Link>
          </div>
          <div className="panel-body flush">
            {channels.length === 0 ? (
              <Empty
                icon={<IconRadio />}
                title="No channels yet"
                action={
                  <Link className="btn sm" href="/channels">
                    Add a channel
                  </Link>
                }
              >
                ClipForge can only detect moments on channels you monitor. Add one, or discover
                what is live on Twitch right now.
              </Empty>
            ) : (
              channels.map((c) => (
                <Link key={c.id} href="/live" className="list-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5 }} className="truncate">
                        {c.display_name}
                      </span>
                      {c.is_live ? <Badge tone="live" dot>live</Badge> : <Badge>offline</Badge>}
                    </div>
                    <div className="faint truncate" style={{ fontSize: 11, marginTop: 2 }}>
                      {c.game_name ?? "—"}
                      {c.viewer_count ? ` · ${c.viewer_count.toLocaleString()} viewers` : ""}
                      {c.moments > 0 ? ` · ${c.moments} moments` : ""}
                    </div>
                  </div>
                  <div style={{ width: 120, flex: "0 0 120px" }}>
                    <Sparkline
                      data={series[c.id]?.length ? series[c.id] : [0, 0, 0, 0]}
                      height={30}
                      width={120}
                      color={c.is_live ? "var(--text)" : "#3a3a41"}
                    />
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconCpu width={13} height={13} /> Resources
            </h2>
            <Badge tone={storagePct > 80 ? "amber" : "green"}>
              {storagePct > 80 ? "tight" : "healthy"}
            </Badge>
          </div>
          <div className="panel-body" style={{ display: "grid", gap: 14 }}>
            <Meter
              label="Clip storage (R2)"
              value={`${fmtBytes(stats.storageBytes)} / ${settings.storageLimitMb} MB`}
              pct={storagePct}
              tone={storagePct > 85 ? "red" : storagePct > 65 ? "amber" : "green"}
            />
            <Meter
              label="D1 rows written today"
              value={`${stats.writesToday.toLocaleString()} / 10,000`}
              pct={writePct}
              tone={writePct > 85 ? "red" : writePct > 65 ? "amber" : "green"}
            />
            <Meter
              label="D1 rows stored"
              value={`${stats.d1Rows.toLocaleString()} / 100,000`}
              pct={rowsPct}
              tone={rowsPct > 85 ? "amber" : "green"}
            />
            <hr className="divider" />
            <div className="spread" style={{ fontSize: 11.5 }}>
              <span className="muted">AI analysis</span>
              <Badge tone={status.ai ? "green" : "amber"}>
                {status.ai ? "workers ai" : "heuristic only"}
              </Badge>
            </div>
            <div className="spread" style={{ fontSize: 11.5 }}>
              <span className="muted">Twitch API</span>
              <Badge tone={status.twitch ? "green" : "red"}>
                {status.twitch ? "connected" : "not configured"}
              </Badge>
            </div>
            <div className="spread" style={{ fontSize: 11.5 }}>
              <span className="muted">Collector</span>
              <span className="faint">
                {collectorRun ? `${collectorRun.status} · ${ago(collectorRun.started_at)}` : "never run"}
              </span>
            </div>
            {/* The channels the last run actually collected, so a flat chart can
                be told apart from a channel nothing was listening to. */}
            {collectorRun?.detail ? (
              <div
                className="faint truncate"
                style={{ fontSize: 10.5, marginTop: -6 }}
                title={collectorRun.detail}
              >
                {collectorRun.detail}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="panel-title">
            <IconFilm width={13} height={13} /> Recently generated
          </h2>
          <Link className="btn sm ghost" href="/clips">
            All clips
          </Link>
        </div>
        <div className="panel-body">
          {recentClips.length === 0 ? (
            <Empty icon={<IconFilm />} title="No clips yet">
              Once a spike clears the quality floor, the renderer cuts a vertical clip and it
              lands here automatically.
            </Empty>
          ) : (
            <div className="clip-grid">
              {recentClips.map((clip) => (
                <Link key={clip.id} href={`/clips?clip=${clip.id}`} className="clip-card">
                  <div className="clip-thumb">
                    {clip.thumb_key ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/media/${clip.thumb_key}`} alt="" loading="lazy" />
                    ) : (
                      <div className="placeholder">
                        {clip.status === "failed" ? "render failed" : "rendering…"}
                      </div>
                    )}
                    <div className="clip-thumb-top">
                      <Badge tone={clip.status === "ready" ? "neutral" : "amber"}>{clip.status}</Badge>
                    </div>
                    <span className="clip-duration">{fmtDuration(clip.duration_ms)}</span>
                  </div>
                  <div className="clip-body">
                    <div className="clip-caption truncate">{clip.caption ?? clip.title ?? "Untitled"}</div>
                    <div className="clip-meta">
                      <span>{clip.channel_name}</span>
                      <span>·</span>
                      <span>{clip.game_name ?? "—"}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconSparkle width={13} height={13} /> Highest rated
            </h2>
          </div>
          <div className="panel-body flush">
            {topClips.length === 0 ? (
              <Empty icon={<IconSparkle />} title="Nothing scored yet" />
            ) : (
              topClips.map((c) => (
                <div key={c.id} className="list-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                      {c.caption ?? c.title}
                    </div>
                    <div className="faint" style={{ fontSize: 11 }}>
                      {c.channel_name} · {c.category ?? "unscored"} · {ago(c.created_at)}
                    </div>
                  </div>
                  <Score value={c.quality_score} />
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconPulse width={13} height={13} /> Latest spikes
            </h2>
            <Link className="btn sm ghost" href="/live">
              Open
            </Link>
          </div>
          <div className="panel-body flush">
            {spikes.length === 0 ? (
              <Empty icon={<IconPulse />} title="No spikes detected">
                The detector needs a live channel with an active collector.
              </Empty>
            ) : (
              spikes.map((s) => (
                <div key={s.id} className="list-row">
                  <div style={{ width: 44 }}>
                    <span className="mono" style={{ color: "var(--text)" }}>
                      {Math.round(s.intensity)}
                    </span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate" style={{ fontSize: 12.5 }}>
                      {s.channel_login} · {s.peak_rate.toFixed(0)}/s peak
                    </div>
                    <div className="faint" style={{ fontSize: 11 }}>
                      {s.baseline_rate.toFixed(1)}/s baseline · {s.unique_chatters} chatters ·{" "}
                      {ago(s.ts_unix)}
                    </div>
                  </div>
                  <Badge tone={s.status === "done" ? "green" : s.status === "failed" ? "red" : "neutral"}>
                    {s.status}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function SetupStep({
  done,
  title,
  detail,
  href,
}: {
  done: boolean;
  title: string;
  detail: string;
  href?: string;
}) {
  return (
    <div className="row" style={{ alignItems: "flex-start", gap: 10, padding: "7px 0" }}>
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: 99,
          flex: "0 0 18px",
          display: "grid",
          placeItems: "center",
          background: done ? "rgba(69,212,131,0.14)" : "rgba(245,183,78,0.12)",
          color: done ? "var(--green)" : "var(--amber)",
          marginTop: 1,
        }}
      >
        {done ? <IconCheck width={11} height={11} /> : <IconX width={11} height={11} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 550 }}>{title}</div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          {detail}
          {href ? (
            <>
              {" "}
              <a href={href} className="mono" style={{ color: "var(--text)" }}>
                open
              </a>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Meter({
  label,
  value,
  pct,
  tone,
}: {
  label: string;
  value: string;
  pct: number;
  tone: "green" | "amber" | "red";
}) {
  return (
    <div>
      <div className="spread" style={{ marginBottom: 5, fontSize: 11.5 }}>
        <span className="muted">{label}</span>
        <span className="mono">{value}</span>
      </div>
      <Bar value={pct} tone={tone} />
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkline } from "./Sparkline";
import { Avatar, Badge, Empty, ago } from "./ui";
import { IconPlus, IconRadio, IconTrash, IconX } from "./icons";
import type { Channel } from "@/lib/types";

interface Discovered {
  id: string;
  login: string;
  displayName: string;
  title: string;
  game: string;
  viewers: number;
  language: string;
  thumbnail: string;
  monitored: boolean;
}

export function ChannelManager({
  channels,
  series,
  spikeCounts,
  maxChannels,
  twitchReady,
  discoveryEnabled,
}: {
  channels: Channel[];
  series: Record<string, number[]>;
  spikeCounts: Record<string, number>;
  maxChannels: number;
  twitchReady: boolean;
  discoveryEnabled: boolean;
}) {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const monitored = channels.filter((c) => c.monitor === 1).length;

  async function add(target: string) {
    const clean = target.trim().toLowerCase().replace(/^@/, "");
    if (!clean) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: clean }),
      });
      const data = (await res.json()) as { error?: string; channel?: Channel; created?: boolean };
      if (!res.ok) {
        setMessage({ tone: "err", text: data.error ?? "Could not add channel" });
      } else {
        setMessage({
          tone: "ok",
          text: data.created
            ? `Added ${data.channel?.display_name}. The collector will pick it up on its next run.`
            : `${data.channel?.display_name} was already added and is now monitored.`,
        });
        setLogin("");
        setDiscovered((prev) =>
          prev ? prev.map((d) => (d.login === clean ? { ...d, monitored: true } : d)) : prev,
        );
        router.refresh();
      }
    } catch {
      setMessage({ tone: "err", text: "Network error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(channel: Channel) {
    if (!confirm(`Stop monitoring ${channel.display_name}? Its chat history is deleted; existing clips are kept.`))
      return;
    setBusy(true);
    const res = await fetch(`/api/channels/${channel.id}`, { method: "DELETE" });
    if (res.ok) {
      setMessage({ tone: "ok", text: `Removed ${channel.display_name}` });
      router.refresh();
    } else {
      setMessage({ tone: "err", text: "Remove failed" });
    }
    setBusy(false);
  }

  async function toggle(channel: Channel) {
    setBusy(true);
    const res = await fetch(`/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: channel.monitor !== 1 }),
    });
    if (res.ok) router.refresh();
    else setMessage({ tone: "err", text: "Update failed" });
    setBusy(false);
  }

  async function discover() {
    setDiscovering(true);
    setMessage(null);
    try {
      const res = await fetch("/api/discover?first=30");
      const data = (await res.json()) as { streams?: Discovered[]; error?: string };
      if (!res.ok) setMessage({ tone: "err", text: data.error ?? "Discovery failed" });
      else setDiscovered(data.streams ?? []);
    } catch {
      setMessage({ tone: "err", text: "Network error" });
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="panel-title">
            <IconPlus width={13} height={13} /> Add a channel
          </h2>
          <span className="faint" style={{ fontSize: 11 }}>
            {monitored}/{maxChannels} slots used
          </span>
        </div>
        <div className="panel-body">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              add(login);
            }}
          >
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="twitch login, e.g. shroud"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              disabled={busy || !twitchReady}
            />
            <button className="btn primary" type="submit" disabled={busy || !twitchReady || !login.trim()}>
              Add
            </button>
            {discoveryEnabled ? (
              <button
                className="btn"
                type="button"
                onClick={discover}
                disabled={discovering || !twitchReady}
              >
                {discovering ? "Finding…" : "Discover live"}
              </button>
            ) : null}
          </form>

          {!twitchReady ? (
            <p className="faint" style={{ fontSize: 11.5, marginBottom: 0, marginTop: 10 }}>
              Twitch credentials are missing. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET as
              project secrets, then redeploy.
            </p>
          ) : null}

          {message ? (
            <p
              style={{
                fontSize: 11.5,
                marginBottom: 0,
                marginTop: 10,
                color: message.tone === "ok" ? "var(--green)" : "var(--red)",
              }}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      </section>

      {discovered ? (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h2 className="panel-title">
              <IconRadio width={13} height={13} /> Live on Twitch now
            </h2>
            <button className="btn sm ghost" onClick={() => setDiscovered(null)}>
              <IconX width={12} height={12} /> Close
            </button>
          </div>
          <div className="panel-body flush" style={{ maxHeight: 420, overflow: "auto" }}>
            {discovered.length === 0 ? (
              <Empty icon={<IconRadio />} title="No live streams returned" />
            ) : (
              discovered.map((s) => (
                <div key={s.id} className="list-row">
                  <Avatar src={s.thumbnail} name={s.displayName} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>{s.displayName}</span>
                      <Badge tone="live" dot>
                        {s.viewers.toLocaleString()}
                      </Badge>
                    </div>
                    <div className="faint truncate" style={{ fontSize: 11 }}>
                      {s.game || "—"} · {s.title || "Untitled"}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    disabled={busy || s.monitored || monitored >= maxChannels}
                    onClick={() => add(s.login)}
                  >
                    {s.monitored ? "Monitored" : "Monitor"}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <IconRadio width={13} height={13} /> Channels
          </h2>
          <span className="faint" style={{ fontSize: 11 }}>
            {channels.length} total
          </span>
        </div>
        <div className="panel-body flush">
          {channels.length === 0 ? (
            <Empty icon={<IconRadio />} title="No channels yet">
              Add a Twitch login above, or use Discover to see what is live right now.
            </Empty>
          ) : (
            channels.map((c) => {
              const s = series[c.id] ?? [];
              return (
                <div key={c.id} className="list-row">
                  <Avatar src={c.avatar_url} name={c.display_name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.display_name}</span>
                      {c.is_live ? <Badge tone="live" dot>live</Badge> : <Badge>offline</Badge>}
                      {c.monitor !== 1 ? <Badge tone="amber">paused</Badge> : null}
                    </div>
                    <div className="faint truncate" style={{ fontSize: 11 }}>
                      {c.game_name ?? "No category"}
                      {c.viewer_count ? ` · ${c.viewer_count.toLocaleString()} viewers` : ""} ·{" "}
                      {spikeCounts[c.id] ?? 0} spikes · {c.moments} moments
                      {c.last_live_at ? ` · last live ${ago(c.last_live_at)}` : ""}
                    </div>
                  </div>
                  <div style={{ width: 92, flex: "0 0 92px" }}>
                    <Sparkline data={s.length ? s : [0, 0, 0]} height={26} width={92} color="#8a8a92" />
                  </div>
                  <button
                    className="btn sm ghost"
                    onClick={() => toggle(c)}
                    disabled={busy}
                    title={c.monitor === 1 ? "Pause monitoring" : "Resume monitoring"}
                  >
                    {c.monitor === 1 ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="btn sm ghost icon danger"
                    onClick={() => remove(c)}
                    disabled={busy}
                    title="Remove channel"
                  >
                    <IconTrash width={12} height={12} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}

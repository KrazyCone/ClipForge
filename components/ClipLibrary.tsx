"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Empty, Score, ago, fmtDuration } from "./ui";
import {
  IconDownload,
  IconFilm,
  IconPlay,
  IconRefresh,
  IconSparkle,
  IconTrash,
  IconX,
} from "./icons";
import type { Clip } from "@/lib/types";

const SORTS = [
  { key: "newest", label: "Newest" },
  { key: "quality", label: "Highest quality" },
  { key: "funnest", label: "Funniest" },
  { key: "intensity", label: "Chat intensity" },
  { key: "duration", label: "Duration" },
  { key: "streamer", label: "Streamer" },
  { key: "game", label: "Game" },
];

const SORT_MAP: Record<string, string> = { funnest: "funniest" };

export function ClipLibrary({
  initialClips,
  initialClipId,
  initialSpikeId,
}: {
  initialClips: Clip[];
  initialClipId: string | null;
  initialSpikeId: string | null;
}) {
  const [clips, setClips] = useState<Clip[]>(initialClips);
  const [sort, setSort] = useState("newest");
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<Clip | null>(
    initialClips.find((c) => c.id === initialClipId) ?? null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(
    async (nextSort: string) => {
      const res = await fetch(`/api/clips?sort=${SORT_MAP[nextSort] ?? nextSort}&limit=120`);
      const data = (await res.json()) as { clips: Clip[] };
      setClips(data.clips ?? []);
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  async function changeSort(value: string) {
    setSort(value);
    await load(value);
  }

  const visible = useMemo(() => {
    let out = clips;
    if (filter === "ready") out = out.filter((c) => c.status === "ready");
    if (filter === "processing") out = out.filter((c) => c.status === "pending" || c.status === "rendering");
    if (filter === "failed") out = out.filter((c) => c.status === "failed");
    if (filter.startsWith("ch:")) out = out.filter((c) => c.channel_login === filter.slice(3));
    if (filter.startsWith("game:")) out = out.filter((c) => c.game_name === filter.slice(5));
    return out;
  }, [clips, filter]);

  const channels = useMemo(
    () => [...new Set(clips.map((c) => c.channel_login).filter(Boolean))] as string[],
    [clips],
  );

  async function remove(clip: Clip) {
    if (!confirm(`Delete this clip? The video file is removed from storage.`)) return;
    setBusy(clip.id);
    const res = await fetch(`/api/clips/${clip.id}`, { method: "DELETE" });
    if (res.ok) {
      setClips((prev) => prev.filter((c) => c.id !== clip.id));
      setOpen(null);
      setToast("Clip deleted");
    } else {
      setToast("Delete failed");
    }
    setBusy(null);
  }

  async function regenerate(clip: Clip) {
    setBusy(clip.id);
    const res = await fetch(`/api/clips/${clip.id}/regenerate`, { method: "POST" });
    const data = (await res.json()) as { caption?: string; provider?: string; error?: string };
    if (res.ok && data.caption) {
      setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, caption: data.caption! } : c)));
      setOpen((prev) => (prev && prev.id === clip.id ? { ...prev, caption: data.caption! } : prev));
      setToast(`New caption via ${data.provider === "heuristic" ? "local generator" : "Workers AI"}`);
    } else {
      setToast(data.error ?? "Could not regenerate");
    }
    setBusy(null);
  }

  async function reprocess(clip: Clip) {
    setBusy(clip.id);
    const res = await fetch(`/api/clips/${clip.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reprocess: true }),
    });
    if (res.ok) {
      setClips((prev) =>
        prev.map((c) => (c.id === clip.id ? { ...c, status: "pending", r2_key: null, thumb_key: null } : c)),
      );
      setToast("Queued for re-render");
      setOpen(null);
    } else {
      setToast("Requeue failed");
    }
    setBusy(null);
  }

  async function saveEdit(clip: Clip, title: string, caption: string) {
    const res = await fetch(`/api/clips/${clip.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, caption }),
    });
    if (res.ok) {
      setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, title, caption } : c)));
      setToast("Saved");
    } else setToast("Save failed");
  }

  if (clips.length === 0 && !initialSpikeId) {
    return (
      <div className="panel">
        <Empty
          icon={<IconFilm />}
          title="The library is empty"
          action={
            <a className="btn sm" href="/channels">
              Monitor a channel
            </a>
          }
        >
          Clips appear here after a detected chat spike passes analysis and the renderer
          finishes cutting it. Nothing is faked: an empty library means no moment has
          cleared the quality floor yet.
        </Empty>
      </div>
    );
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {[
            { key: "all", label: `All ${clips.length}` },
            { key: "ready", label: "Ready" },
            { key: "processing", label: "Processing" },
            { key: "failed", label: "Failed" },
          ].map((f) => (
            <button
              key={f.key}
              className={`btn sm ${filter === f.key ? "primary" : "ghost"}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
          {channels.slice(0, 4).map((ch) => (
            <button
              key={ch}
              className={`btn sm ${filter === `ch:${ch}` ? "primary" : "ghost"}`}
              onClick={() => setFilter(`ch:${ch}`)}
            >
              {ch}
            </button>
          ))}
        </div>
        <select className="select" value={sort} onChange={(e) => changeSort(e.target.value)}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="panel">
          <Empty icon={<IconFilm />} title="No clips match this filter" />
        </div>
      ) : (
        <div className="clip-grid">
          {visible.map((clip) => (
            <article key={clip.id} className="clip-card">
              <div className="clip-thumb" onClick={() => setOpen(clip)}>
                {clip.thumb_key ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/${clip.thumb_key}`} alt={clip.caption ?? ""} loading="lazy" />
                ) : (
                  <div className="placeholder">
                    {clip.status === "failed" ? "render failed" : "processing…"}
                  </div>
                )}
                <div className="clip-thumb-top">
                  <Badge
                    tone={
                      clip.status === "ready"
                        ? "neutral"
                        : clip.status === "failed"
                          ? "red"
                          : "amber"
                    }
                  >
                    {clip.status}
                  </Badge>
                  {clip.quality_score !== null ? (
                    <span
                      className="badge"
                      style={{ background: "rgba(0,0,0,0.6)", borderColor: "transparent" }}
                    >
                      <Score value={clip.quality_score} />
                    </span>
                  ) : null}
                </div>
                <span className="clip-duration">{fmtDuration(clip.duration_ms)}</span>
              </div>
              <div className="clip-body">
                <div className="clip-caption" style={{ minHeight: 34 }}>
                  {clip.caption ?? clip.title ?? "Untitled"}
                </div>
                <div className="clip-meta">
                  <span className="truncate" style={{ maxWidth: "100%" }}>
                    {clip.channel_name} · {clip.game_name ?? "—"}
                  </span>
                  <span className="faint">{ago(clip.created_at)}</span>
                </div>
                <div className="clip-actions">
                  <button className="btn sm ghost icon" title="Play" onClick={() => setOpen(clip)}>
                    <IconPlay width={12} height={12} />
                  </button>
                  {clip.status === "ready" ? (
                    <a
                      className="btn sm ghost icon"
                      title="Download"
                      href={`/api/clips/${clip.id}/download`}
                    >
                      <IconDownload width={12} height={12} />
                    </a>
                  ) : null}
                  <button
                    className="btn sm ghost icon"
                    title="Regenerate caption"
                    disabled={busy === clip.id}
                    onClick={() => regenerate(clip)}
                  >
                    <IconSparkle width={12} height={12} />
                  </button>
                  <button
                    className="btn sm ghost icon"
                    title="Delete"
                    disabled={busy === clip.id}
                    onClick={() => remove(clip)}
                    style={{ marginLeft: "auto" }}
                  >
                    <IconTrash width={12} height={12} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {open ? (
        <ClipModal
          clip={open}
          busy={busy === open.id}
          onClose={() => setOpen(null)}
          onDelete={() => remove(open)}
          onRegenerate={() => regenerate(open)}
          onReprocess={() => reprocess(open)}
          onSave={(title, caption) => saveEdit(open, title, caption)}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}

function ClipModal({
  clip,
  busy,
  onClose,
  onDelete,
  onRegenerate,
  onReprocess,
  onSave,
}: {
  clip: Clip;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onReprocess: () => void;
  onSave: (title: string, caption: string) => void;
}) {
  const [title, setTitle] = useState(clip.title ?? "");
  const [caption, setCaption] = useState(clip.caption ?? "");
  const [copied, setCopied] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ position: "relative" }}>
        <button className="btn icon ghost modal-close" onClick={onClose} aria-label="Close">
          <IconX width={14} height={14} />
        </button>
        <div className="modal-video">
          {clip.r2_key && clip.status === "ready" ? (
            <video
              src={`/api/media/${clip.r2_key}`}
              poster={clip.thumb_key ? `/api/media/${clip.thumb_key}` : undefined}
              controls
              autoPlay
              playsInline
            />
          ) : (
            <div style={{ padding: 30, textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
              {clip.status === "failed"
                ? clip.error ?? "Rendering failed"
                : "This clip is still being rendered."}
            </div>
          )}
        </div>

        <div className="modal-info">
          <div>
            <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <Badge tone={clip.status === "ready" ? "green" : clip.status === "failed" ? "red" : "amber"}>
                {clip.status}
              </Badge>
              <Badge tone="neutral">{clip.category ?? "unscored"}</Badge>
              <Badge>{clip.provider ?? "heuristic"}</Badge>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.015em" }}>
              {clip.channel_name}
              {clip.game_name ? ` · ${clip.game_name}` : ""}
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
              {fmtDuration(clip.duration_ms)} · {clip.width}×{clip.height} · source{" "}
              {clip.source_ts ? ago(clip.source_ts) : "unknown"} · {clip.intensity?.toFixed(0) ?? 0}{" "}
              spike intensity
            </div>
          </div>

          <div className="grid grid-2">
            <div className="field">
              <span className="field-label">Quality</span>
              <Score value={clip.quality_score} />
            </div>
            <div className="field">
              <span className="field-label">Funniness</span>
              <Score value={clip.funniness} />
            </div>
          </div>

          <div className="field">
            <span className="field-label">Caption</span>
            <input
              className="input"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={120}
            />
          </div>

          <div className="field">
            <span className="field-label">Title</span>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </div>

          {clip.description ? (
            <div className="field">
              <span className="field-label">AI assessment</span>
              <div className="code-box">{clip.description}</div>
            </div>
          ) : null}

          {clip.hashtags_json ? (
            <div className="field">
              <span className="field-label">Hashtags</span>
              <div className="row" style={{ flexWrap: "wrap", gap: 5 }}>
                {(JSON.parse(clip.hashtags_json) as string[]).map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            </div>
          ) : null}

          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: "auto" }}>
            <button
              className="btn sm"
              onClick={() => {
                onSave(title, caption);
                setCopied(false);
              }}
            >
              Save edits
            </button>
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => {
                navigator.clipboard?.writeText(caption).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Copied" : "Copy caption"}
            </button>
            <button className="btn sm" disabled={busy} onClick={onRegenerate}>
              <IconSparkle width={12} height={12} /> New caption
            </button>
            {clip.status === "ready" ? (
              <>
                <a className="btn sm" href={`/api/clips/${clip.id}/download`}>
                  <IconDownload width={12} height={12} /> MP4
                </a>
                <button className="btn sm" disabled={busy} onClick={onReprocess}>
                  <IconRefresh width={12} height={12} /> Reprocess
                </button>
              </>
            ) : null}
            <button
              className="btn sm danger"
              disabled={busy}
              onClick={onDelete}
              style={{ marginLeft: "auto" }}
            >
              <IconTrash width={12} height={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

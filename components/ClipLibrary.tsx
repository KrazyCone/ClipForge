"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Empty, Score, ago, fmtDuration } from "./ui";
import {
  IconDownload,
  IconFilm,
  IconPlay,
  IconRefresh,
  IconSparkle,
  IconThumbDown,
  IconThumbUp,
  IconTrash,
  IconX,
} from "./icons";
import { ClipFeedbackBox } from "./ClipFeedback";
import { parseReasons, summariseFeedback } from "@/lib/feedback";
import { parseWebcamBox, WEBCAM_REGION_OPTIONS } from "@/lib/webcam";
import type {
  ClipFeedback,
  FeedbackSentiment,
  FeedbackSuggestion,
} from "@/lib/feedback";
import type { AppSettings, Clip } from "@/lib/types";

const SORTS = [
  { key: "taste", label: "Your feedback" },
  { key: "newest", label: "Newest" },
  { key: "quality", label: "Highest quality" },
  { key: "funnest", label: "Funniest" },
  { key: "intensity", label: "Chat intensity" },
  { key: "duration", label: "Duration" },
  { key: "streamer", label: "Streamer" },
  { key: "game", label: "Game" },
];

const SORT_MAP: Record<string, string> = { funnest: "funniest" };

type TasteFilter = "all" | "like" | "dislike" | "unrated";

export function ClipLibrary({
  initialClips,
  initialClipId,
  initialSpikeId,
  initialFeedback,
  settings,
}: {
  initialClips: Clip[];
  initialClipId: string | null;
  initialSpikeId: string | null;
  initialFeedback: ClipFeedback[];
  settings: AppSettings;
}) {
  const router = useRouter();
  const [clips, setClips] = useState<Clip[]>(initialClips);
  const [sort, setSort] = useState("newest");
  const [filter, setFilter] = useState<string>("all");
  const [taste, setTaste] = useState<TasteFilter>("all");
  const [open, setOpen] = useState<Clip | null>(
    initialClips.find((c) => c.id === initialClipId) ?? null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [current, setCurrent] = useState<AppSettings>(settings);
  const [feedback, setFeedback] = useState<Record<string, ClipFeedback>>(() =>
    Object.fromEntries(initialFeedback.map((f) => [f.clip_id, f])),
  );

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

  // While a re-cut is queued, refresh so the badge clears when the collector
  // finishes and the card picks up the new render.
  const rebuilding = clips.some((c) => c.rebuild_pending);
  useEffect(() => {
    if (!rebuilding) return;
    const t = setInterval(() => {
      void load(sort === "taste" ? "newest" : sort);
    }, 60_000);
    return () => clearInterval(t);
  }, [rebuilding, sort, load]);

  // Keep an open modal in step with refreshed clip data (queued re-cut, new render).
  useEffect(() => {
    if (!open) return;
    const fresh = clips.find((c) => c.id === open.id);
    if (
      fresh &&
      (fresh.rebuild_pending !== open.rebuild_pending ||
        fresh.status !== open.status ||
        fresh.r2_key !== open.r2_key)
    ) {
      setOpen(fresh);
    }
  }, [clips, open]);

  async function changeSort(value: string) {
    setSort(value);
    // "Your feedback" ranks the clips already loaded, so it needs no round trip.
    if (value !== "taste") await load(value);
  }

  const summary = useMemo(
    () => summariseFeedback(Object.values(feedback), current),
    [feedback, current],
  );

  const counts = useMemo(
    () => ({
      all: clips.length,
      like: clips.filter((c) => feedback[c.id]?.sentiment === "like").length,
      dislike: clips.filter((c) => feedback[c.id]?.sentiment === "dislike").length,
      unrated: clips.filter((c) => !feedback[c.id]).length,
    }),
    [clips, feedback],
  );

  const visible = useMemo(() => {
    let out = clips;
    if (filter === "ready") out = out.filter((c) => c.status === "ready");
    if (filter === "processing")
      out = out.filter((c) => c.status === "pending" || c.status === "rendering");
    if (filter === "failed") out = out.filter((c) => c.status === "failed");
    if (filter.startsWith("ch:")) out = out.filter((c) => c.channel_login === filter.slice(3));
    if (filter.startsWith("game:")) out = out.filter((c) => c.game_name === filter.slice(5));

    if (taste === "like") out = out.filter((c) => feedback[c.id]?.sentiment === "like");
    if (taste === "dislike") out = out.filter((c) => feedback[c.id]?.sentiment === "dislike");
    if (taste === "unrated") out = out.filter((c) => !feedback[c.id]);

    if (sort === "taste") {
      const rank = (c: Clip) =>
        feedback[c.id]?.sentiment === "like"
          ? 2
          : feedback[c.id]?.sentiment === "dislike"
            ? 0
            : 1;
      out = [...out].sort(
        (a, b) =>
          rank(b) - rank(a) || (b.quality_score ?? 0) - (a.quality_score ?? 0),
      );
    }
    return out;
  }, [clips, filter, taste, sort, feedback]);

  const channels = useMemo(
    () => [...new Set(clips.map((c) => c.channel_login).filter(Boolean))] as string[],
    [clips],
  );

  async function vote(clip: Clip, sentiment: FeedbackSentiment) {
    const existing = feedback[clip.id];
    setBusy(clip.id);
    const res = await fetch(`/api/clips/${clip.id}/feedback`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sentiment,
        reasons: parseReasons(existing?.reasons_json),
        note: existing?.note ?? "",
      }),
    });
    const data = (await res.json()) as { feedback?: ClipFeedback; error?: string };
    if (res.ok && data.feedback) {
      setFeedback((prev) => ({ ...prev, [clip.id]: data.feedback! }));
      setToast(sentiment === "like" ? "Liked — more like this" : "Disliked — less like this");
    } else {
      setToast(data.error ?? "Could not save feedback");
    }
    setBusy(null);
  }

  async function rebuild(
    clip: Clip,
    options: {
      makeLonger?: boolean;
      needsContext?: boolean;
      webcamRegion?: string;
      title?: string;
      caption?: string;
      direction?: string;
    } = {},
  ) {
    setBusy(clip.id);
    const res = await fetch(`/api/clips/${clip.id}/rebuild`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
    const data = (await res.json()) as { ok?: boolean; queued?: boolean; error?: string };
    if (res.ok) {
      // The clip stays playable, but the card shows the re-cut is waiting.
      setClips((prev) =>
        prev.map((c) => (c.id === clip.id ? { ...c, rebuild_pending: 1 } : c)),
      );
      setOpen((prev) =>
        prev && prev.id === clip.id ? { ...prev, rebuild_pending: 1 } : prev,
      );
      setToast(
        options.makeLonger
          ? "Queued — a longer re-cut is on its way"
          : "Queued — the re-cut starts on the next renderer pass",
      );
      await load(sort === "taste" ? "newest" : sort);
    } else {
      setToast(data.error ?? "Could not queue the rebuild");
    }
    setBusy(null);
  }

  async function applySuggestion(patch: Partial<AppSettings>) {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as { settings?: AppSettings; error?: string };
    if (res.ok && data.settings) {
      setCurrent(data.settings);
      setToast("Filters updated from your feedback");
      router.refresh();
    } else {
      setToast(data.error ?? "Could not update filters");
    }
  }

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
    const data = (await res.json()) as {
      title?: string;
      caption?: string;
      provider?: string;
      error?: string;
    };
    if (res.ok && data.title && data.caption) {
      const next = { title: data.title, caption: data.caption };
      setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, ...next } : c)));
      setOpen((prev) => (prev && prev.id === clip.id ? { ...prev, ...next } : prev));
      setToast(
        `New title and caption via ${data.provider === "heuristic" ? "local generator" : "Workers AI"}`,
      );
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
      <div className="spread" style={{ marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
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

      <div
        className="row"
        style={{ gap: 6, flexWrap: "wrap", marginBottom: 14 }}
      >
        <span className="faint" style={{ fontSize: 11 }}>
          Your feedback
        </span>
        {[
          { key: "all" as TasteFilter, label: "All" },
          { key: "like" as TasteFilter, label: `Liked ${counts.like}` },
          { key: "dislike" as TasteFilter, label: `Disliked ${counts.dislike}` },
          { key: "unrated" as TasteFilter, label: `Unrated ${counts.unrated}` },
        ].map((f) => (
          <button
            key={f.key}
            className={`btn sm ${taste === f.key ? "primary" : "ghost"}`}
            onClick={() => setTaste(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="panel">
          <Empty icon={<IconFilm />} title="No clips match this filter" />
        </div>
      ) : (
        <div className="clip-grid">
          {visible.map((clip) => {
            const reaction = feedback[clip.id];
            return (
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
                    {reaction ? (
                      <Badge tone={reaction.sentiment === "like" ? "green" : "red"}>
                        {reaction.sentiment === "like" ? "liked" : "disliked"}
                      </Badge>
                    ) : null}
                    {clip.rebuild_pending ? <Badge tone="amber">re-cut queued</Badge> : null}
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
                      title="Regenerate title and caption"
                      disabled={busy === clip.id}
                      onClick={() => regenerate(clip)}
                    >
                      <IconSparkle width={12} height={12} />
                    </button>
                    <button
                      className="btn sm ghost icon"
                      title="Like this clip"
                      aria-pressed={reaction?.sentiment === "like"}
                      disabled={busy === clip.id}
                      onClick={() => vote(clip, "like")}
                      style={reaction?.sentiment === "like" ? { color: "var(--accent-ink)", background: "var(--accent)" } : undefined}
                    >
                      <IconThumbUp width={12} height={12} />
                    </button>
                    <button
                      className="btn sm ghost icon"
                      title="Dislike this clip"
                      aria-pressed={reaction?.sentiment === "dislike"}
                      disabled={busy === clip.id}
                      onClick={() => vote(clip, "dislike")}
                      style={reaction?.sentiment === "dislike" ? { color: "#efb0b0", border: "1px solid rgba(224,82,82,0.55)" } : undefined}
                    >
                      <IconThumbDown width={12} height={12} />
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
            );
          })}
        </div>
      )}

      {open ? (
        <ClipModal
          clip={open}
          feedback={feedback[open.id] ?? null}
          busy={busy === open.id}
          onClose={() => setOpen(null)}
          onDelete={() => remove(open)}
          onRegenerate={() => regenerate(open)}
          onReprocess={() => reprocess(open)}
          onSave={(title, caption) => saveEdit(open, title, caption)}
          suggestion={summary.suggestion}
          webcamFocus={current.webcamFocus}
          onRebuild={(options) => rebuild(open, options)}
          onApplySuggestion={applySuggestion}
          onFeedback={(next) =>
            setFeedback((prev) => {
              const copy = { ...prev };
              if (next) copy[open.id] = next;
              else delete copy[open.id];
              return copy;
            })
          }
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}

function ClipModal({
  clip,
  feedback,
  busy,
  suggestion,
  webcamFocus,
  onClose,
  onDelete,
  onRegenerate,
  onReprocess,
  onSave,
  onRebuild,
  onApplySuggestion,
  onFeedback,
}: {
  clip: Clip;
  feedback: ClipFeedback | null;
  busy: boolean;
  suggestion: FeedbackSuggestion | null;
  webcamFocus: boolean;
  onClose: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onReprocess: () => void;
  onSave: (title: string, caption: string) => void;
  onRebuild: (options: {
    makeLonger?: boolean;
    needsContext?: boolean;
    webcamRegion?: string;
    title?: string;
    caption?: string;
    direction?: string;
  }) => void;
  onApplySuggestion: (patch: Partial<AppSettings>) => void;
  onFeedback: (feedback: ClipFeedback | null) => void;
}) {
  const [title, setTitle] = useState(clip.title ?? "");
  const [caption, setCaption] = useState(clip.caption ?? "");
  const [copied, setCopied] = useState(false);
  // A regenerate (or a refresh) replaces the clip's copy while the modal stays
  // open, so the fields follow the stored values instead of going stale.
  useEffect(() => {
    setTitle(clip.title ?? "");
    setCaption(clip.caption ?? "");
  }, [clip.id, clip.title, clip.caption]);
  const [makeLonger, setMakeLonger] = useState(false);
  const [needsContext, setNeedsContext] = useState(false);
  const [webcamRegion, setWebcamRegion] = useState("auto");
  // Starts from the note written under "Your take" so the same words reach the
  // analyser, and stays editable for this cut only.
  const [direction, setDirection] = useState(feedback?.note ?? "");
  useEffect(() => {
    // Only fills an empty box: never overwrites what is being typed here.
    if (!direction && feedback?.note) setDirection(feedback.note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback?.note]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ position: "relative" }}>
        <button className="btn icon ghost modal-close" onClick={onClose} aria-label="Close">
          <IconX width={14} height={14} />
        </button>
        <div className="modal-media">
        <div className="modal-video">
          {clip.r2_key && clip.status === "ready" ? (
            <video
              src={`/api/media/${clip.r2_key}`}
              poster={clip.thumb_key ? `/api/media/${clip.thumb_key}` : undefined}
              controls
              autoPlay
              preload="auto"
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

        <div className="modal-suggest">
          <div className="spread" style={{ gap: 8 }}>
            <span className="setting-label">Reprocess &amp; suggestions</span>
            {suggestion ? <Badge tone="neutral">from your feedback</Badge> : null}
          </div>
          {suggestion ? (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{suggestion.headline}</div>
              <div className="setting-hint">{suggestion.detail}</div>
            </>
          ) : (
            <div className="setting-hint">
              No suggestion yet — rate a few clips and one appears here. Reprocess works
              either way.
            </div>
          )}

          {/* Every control below is a setting for the re-cut: nothing is queued
              until the one button is pressed, so the cut is decided in one go. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="check-inline" title="Re-cut with more footage around the moment">
              <input
                type="checkbox"
                checked={makeLonger}
                disabled={busy || Boolean(clip.rebuild_pending)}
                onChange={(event) => setMakeLonger(event.target.checked)}
              />
              Make it longer
            </label>
            <label className="check-inline" title="Include the lead-up and full exchange, not just the payoff">
              <input
                type="checkbox"
                checked={needsContext}
                disabled={busy || Boolean(clip.rebuild_pending)}
                onChange={(event) => setNeedsContext(event.target.checked)}
              />
              Include the setup (extra context)
            </label>
            <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span className="faint" style={{ fontSize: 10.5 }}>
                Webcam position
              </span>
              <select
                className="select"
                value={webcamRegion}
                disabled={busy || Boolean(clip.rebuild_pending)}
                onChange={(event) => setWebcamRegion(event.target.value)}
                style={{ fontSize: 11.5, padding: "4px 6px" }}
              >
                <option value="auto">Auto-detect</option>
                {WEBCAM_REGION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value="none">No webcam</option>
              </select>
            </div>
            <div className="field">
              <span className="field-label">What should change (optional)</span>
              <textarea
                className="textarea"
                rows={2}
                maxLength={500}
                value={direction}
                disabled={busy || Boolean(clip.rebuild_pending)}
                onChange={(event) => setDirection(event.target.value)}
                placeholder="e.g. start earlier so the joke lands, keep the face cam big"
              />
            </div>
          </div>

          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button
              className="btn sm primary"
              disabled={busy || Boolean(clip.rebuild_pending)}
              onClick={() =>
                onRebuild({
                  makeLonger,
                  needsContext,
                  webcamRegion: webcamRegion === "auto" ? undefined : webcamRegion,
                  title: title.trim() || undefined,
                  caption: caption.trim() || undefined,
                  direction: direction.trim() || undefined,
                })
              }
            >
              <IconRefresh width={12} height={12} />{" "}
              {clip.rebuild_pending ? "Re-cut queued" : "Re-cut with these settings"}
            </button>
            <button
              className="btn sm"
              disabled={!suggestion || busy}
              title={
                suggestion
                  ? "Save this change as the default for every other clip"
                  : "Rate a few clips first — there is nothing to apply yet"
              }
              onClick={() => suggestion && onApplySuggestion(suggestion.patch)}
            >
              Apply to all other clips
            </button>
          </div>

          <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
            {clip.rebuild_pending
              ? "Queued — waiting for the collector. The current cut stays playable until the new one replaces it."
              : "The re-cut uses these settings, the title and caption above, and what you wrote in Your take. Nothing is queued until you press Re-cut."}
          </div>
          <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
            {(() => {
              const box = parseWebcamBox(clip.webcam_json);
              if (!box) {
                return "Webcam: none detected when this clip was analysed — Re-cut to try again.";
              }
              let region = "detected";
              try {
                const stored = JSON.parse(clip.webcam_json ?? "{}") as {
                  region?: string;
                  size?: string;
                };
                if (stored.region) {
                  const label =
                    WEBCAM_REGION_OPTIONS.find((option) => option.value === stored.region)?.label ??
                    stored.region.split("-").join(" ");
                  region = `${label.toLowerCase()}${stored.size ? `, ${stored.size}` : ""}`;
                }
              } catch {
                /* keep the generic label */
              }
              return webcamFocus
                ? `Webcam: ${region} — enlarged above the gameplay.`
                : `Webcam: ${region} — enlargement is switched off in Settings.`;
            })()}
          </div>

        </div>
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

          <ClipFeedbackBox key={clip.id} clip={clip} value={feedback} onChange={onFeedback} />

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
              <IconSparkle width={12} height={12} /> New title &amp; caption
            </button>
            {clip.status === "ready" ? (
              <a className="btn sm" href={`/api/clips/${clip.id}/download`}>
                <IconDownload width={12} height={12} /> MP4
              </a>
            ) : null}
            {clip.spike_id ? (
              <button className="btn sm" disabled={busy} onClick={onReprocess}>
                <IconRefresh width={12} height={12} /> Re-render
              </button>
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

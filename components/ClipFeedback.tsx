"use client";

import { useEffect, useState } from "react";
import { Badge } from "./ui";
import { IconCheck, IconThumbDown, IconThumbUp } from "./icons";
import { REASONS, parseReasons } from "@/lib/feedback";
import type { ClipFeedback, FeedbackSentiment } from "@/lib/feedback";
import type { Clip } from "@/lib/types";

/**
 * Like / dislike for one clip. The vote saves on press; the reasons and note
 * are optional detail that gets attached to whichever vote is selected.
 */
export function ClipFeedbackBox({
  clip,
  value,
  onChange,
}: {
  clip: Clip;
  value: ClipFeedback | null;
  onChange: (feedback: ClipFeedback | null) => void;
}) {
  const [sentiment, setSentiment] = useState<FeedbackSentiment | null>(
    value?.sentiment ?? null,
  );
  const [reasons, setReasons] = useState<string[]>(parseReasons(value?.reasons_json));
  const [note, setNote] = useState(value?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);

  async function save(next: FeedbackSentiment, nextReasons = reasons, nextNote = note) {
    const previous = sentiment;
    setSentiment(next);
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}/feedback`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sentiment: next, reasons: nextReasons, note: nextNote }),
      });
      const data = (await res.json()) as { feedback?: ClipFeedback; error?: string };
      if (!res.ok || !data.feedback) throw new Error(data.error ?? "Could not save");
      onChange(data.feedback);
      setMsg(next === "like" ? "Saved — more like this" : "Saved — less like this");
    } catch (err) {
      setSentiment(previous);
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}/feedback`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not clear");
      onChange(null);
      setSentiment(null);
      setReasons([]);
      setNote("");
      setMsg("Cleared");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear");
    } finally {
      setSaving(false);
    }
  }

  function toggleReason(slug: string) {
    setReasons((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "#141416",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div className="spread" style={{ alignItems: "flex-start", gap: 10 }}>
        <div>
          <div className="setting-label" style={{ fontSize: 12.5 }}>
            Your take
          </div>
          <div className="setting-hint" style={{ marginTop: 2 }}>
            One press saves. Likes and dislikes tune the filters and the cut window.
          </div>
        </div>
        {value ? (
          <Badge tone={value.sentiment === "like" ? "green" : "red"}>
            {value.sentiment === "like" ? "liked" : "disliked"}
          </Badge>
        ) : null}
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="vote"
          data-on={sentiment === "like" ? "like" : undefined}
          onClick={() => save("like")}
          disabled={saving}
        >
          <IconThumbUp width={14} height={14} /> Like
        </button>
        <button
          type="button"
          className="vote"
          data-on={sentiment === "dislike" ? "dislike" : undefined}
          onClick={() => save("dislike")}
          disabled={saving}
        >
          <IconThumbDown width={14} height={14} /> Dislike
        </button>
      </div>

      <div className="field">
        <span className="field-label">What stood out (optional)</span>
        <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
          {REASONS.map((reason) => {
            const on = reasons.includes(reason.slug);
            return (
              <button
                key={reason.slug}
                type="button"
                className={`btn sm ${on ? "primary" : "ghost"}`}
                style={on ? undefined : { border: "1px solid var(--border)" }}
                onClick={() => toggleReason(reason.slug)}
                aria-pressed={on}
              >
                {reason.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <span className="field-label">In your words (optional)</span>
        <textarea
          className="textarea"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="e.g. the cut started after the joke landed"
        />
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn sm"
          disabled={!sentiment || saving}
          onClick={() => sentiment && save(sentiment)}
        >
          {saving ? "Saving…" : "Save details"}
        </button>
        {value ? (
          <button type="button" className="btn sm ghost" onClick={clear} disabled={saving}>
            Clear
          </button>
        ) : null}
        {msg ? (
          <span
            className="row"
            style={{ fontSize: 11.5, color: "var(--green)", gap: 5 }}
          >
            <IconCheck width={12} height={12} /> {msg}
          </span>
        ) : null}
        {error ? (
          <span style={{ fontSize: 11.5, color: "#efb0b0" }}>{error}</span>
        ) : null}
      </div>
    </div>
  );
}

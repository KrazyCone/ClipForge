"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, fmtBytes } from "./ui";
import { IconAlert, IconCheck, IconDatabase, IconSparkle } from "./icons";
import { summariseFeedback } from "@/lib/feedback";
import type { ClipFeedback } from "@/lib/feedback";
import type { AppSettings } from "@/lib/types";
import type { SystemStatus } from "@/lib/status";
import type { Stats } from "@/lib/queries";

export function SettingsForm({
  initial,
  status,
  stats,
  feedback,
}: {
  initial: AppSettings;
  status: SystemStatus;
  stats: Stats;
  feedback: ClipFeedback[];
}) {
  const router = useRouter();
  const [s, setS] = useState<AppSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [licensing, setLicensing] = useState(false);
  const [licence, setLicence] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const summary = summariseFeedback(feedback, s);

  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setToast(data.error ?? "Save failed");
      else {
        setToast("Settings saved");
        router.refresh();
      }
    } catch {
      setToast("Network error");
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 3000);
    }
  }

  /** Save the feedback suggestion for every clip, without a second save step. */
  async function applySuggestion() {
    if (!summary.suggestion) return;
    const next = { ...s, ...summary.suggestion.patch };
    setS(next);
    setApplying(true);
    setToast(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setToast(data.error ?? "Apply failed");
      else {
        setToast("Applied to every clip and new moments");
        router.refresh();
      }
    } catch {
      setToast("Network error");
    } finally {
      setApplying(false);
      setTimeout(() => setToast(null), 3200);
    }
  }

  async function acceptLicence() {
    setLicensing(true);
    setLicence(null);
    try {
      const res = await fetch("/api/ai/license", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; model?: string; error?: string };
      setLicence(data.ok ? `Accepted for ${data.model}` : (data.error ?? "Acceptance failed"));
    } catch {
      setLicence("Network error");
    } finally {
      setLicensing(false);
    }
  }

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="panel-title">
            <IconSparkle width={13} height={13} /> Suggestions for all clips
          </h2>
          <Badge tone={summary.total ? "neutral" : ""}>{summary.total} rated</Badge>
        </div>
        <div className="panel-body">
          {summary.total === 0 ? (
            <div className="setting-hint" style={{ maxWidth: 620 }}>
              Nothing rated yet. Open the <a href="/clips" style={{ color: "var(--text)", textDecoration: "underline" }}>clip library</a>{" "}
              and like or dislike a few clips — the suggestion for every clip shows up here.
            </div>
          ) : (
            <div
              style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}
            >
              <div style={{ flex: "1 1 240px" }}>
                <div className="setting-label">
                  {summary.liked} liked · {summary.disliked} disliked
                </div>
                {summary.reasons.length ? (
                  <div className="row" style={{ gap: 5, flexWrap: "wrap", marginTop: 7 }}>
                    {summary.reasons.slice(0, 5).map((reason) => (
                      <Badge key={reason.slug}>
                        {reason.label} ×{reason.count}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <div
                style={{
                  flex: "2 1 360px",
                  borderLeft: "1px solid var(--border)",
                  paddingLeft: 16,
                }}
              >
                {summary.suggestion ? (
                  <>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {summary.suggestion.headline}
                    </div>
                    <div className="setting-hint" style={{ maxWidth: "100%", marginTop: 3 }}>
                      {summary.suggestion.detail}
                    </div>
                    <button
                      className="btn sm primary"
                      style={{ marginTop: 10 }}
                      disabled={applying}
                      onClick={applySuggestion}
                    >
                      {applying ? "Applying…" : "Apply to all clips"}
                    </button>
                  </>
                ) : (
                  <div className="setting-hint" style={{ maxWidth: "100%" }}>
                    No change recommended yet: nothing you liked sits below the current
                    floor, and your notes do not point at the cut. Keep rating clips and
                    this updates.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="panel-title">
            <IconSparkle width={13} height={13} /> Direction for all clips
          </h2>
          <Badge tone={s.clipDirection.trim() ? "green" : ""}>
            {s.clipDirection.trim() ? "active" : "empty"}
          </Badge>
        </div>
        <div className="panel-body">
          <div className="setting-hint" style={{ maxWidth: "100%", marginBottom: 8 }}>
            Written into the analyser prompt for every new clip: what to pick, how titles
            read, how captions sound. With Workers AI off, clips use the local heuristic and
            this box has no effect.
          </div>
          <textarea
            className="textarea"
            rows={3}
            maxLength={1200}
            value={s.clipDirection}
            onChange={(e) => set("clipDirection", e.target.value)}
            placeholder="e.g. Pick insane gameplay and rage moments, not just loud chat. Titles under 45 characters and concrete. Captions sound like a friend, no chat references, no emoji spam."
          />
          <div className="faint" style={{ fontSize: 10.5, marginTop: 6 }}>
            {s.clipDirection.length}/1200 · applied when you press Save changes, and to every
            caption you regenerate after that
          </div>
        </div>
      </section>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconSparkle width={13} height={13} /> Detection
            </h2>
          </div>
          <div>
            <Row label="Spike sensitivity" hint="Lower is stricter. The detector still requires a statistical anomaly, so a quiet channel is not compared with a busy one.">
              <input
                type="range"
                min={0}
                max={100}
                value={s.spikeSensitivity}
                onChange={(e) => set("spikeSensitivity", Number(e.target.value))}
              />
              <span className="mono" style={{ width: 26, textAlign: "right" }}>
                {s.spikeSensitivity}
              </span>
            </Row>
            <Row label="Minimum AI quality score" hint="Clips scoring below this are skipped instead of rendered. Saves storage and render time.">
              <input
                type="range"
                min={0}
                max={95}
                step={5}
                value={s.minQualityScore}
                onChange={(e) => set("minQualityScore", Number(e.target.value))}
              />
              <span className="mono" style={{ width: 26, textAlign: "right" }}>
                {s.minQualityScore}
              </span>
            </Row>
            <Row label="Maximum simultaneous channels" hint="Hard cap on monitored channels. Each one costs ~1,440 D1 row writes/day, against a 10,000/day free budget.">
              <input
                type="number"
                className="input"
                style={{ width: 76 }}
                min={1}
                max={50}
                value={s.maxChannels}
                onChange={(e) => set("maxChannels", Number(e.target.value))}
              />
            </Row>
            <Row label="Auto-process clips" hint="When off, spikes are still detected and stored, but nothing is rendered.">
              <Switch on={s.autoProcess} onChange={(v) => set("autoProcess", v)} />
            </Row>
            <Row label="Discover live channels" hint="Shows Twitch's currently-live channels on the Channels page. Discovery never auto-adds anything.">
              <Switch on={s.discoveryEnabled} onChange={(v) => set("discoveryEnabled", v)} />
            </Row>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconDatabase width={13} height={13} /> Clip output
            </h2>
          </div>
          <div>
            <Row label="Clip duration" hint="Target length of the final short. The analyser trims further if the moment ends sooner.">
              <input
                type="range"
                min={6}
                max={60}
                value={s.clipDurationSec}
                onChange={(e) => set("clipDurationSec", Number(e.target.value))}
              />
              <span className="mono" style={{ width: 34, textAlign: "right" }}>{s.clipDurationSec}s</span>
            </Row>
            <Row label="Pre-event buffer" hint="Seconds kept before the detected spike. Only available from the archive VOD, not a live buffer.">
              <input
                type="range"
                min={2}
                max={30}
                value={s.preEventSec}
                onChange={(e) => set("preEventSec", Number(e.target.value))}
              />
              <span className="mono" style={{ width: 34, textAlign: "right" }}>{s.preEventSec}s</span>
            </Row>
            <Row label="Post-event buffer" hint="Seconds captured after the spike peak.">
              <input
                type="range"
                min={2}
                max={30}
                value={s.postEventSec}
                onChange={(e) => set("postEventSec", Number(e.target.value))}
              />
              <span className="mono" style={{ width: 34, textAlign: "right" }}>{s.postEventSec}s</span>
            </Row>
            <Row label="Aspect ratio" hint="9:16 for TikTok/Shorts/Reels. 1:1 and 16:9 are available for other destinations.">
              <select
                className="select"
                value={s.aspectRatio}
                onChange={(e) => set("aspectRatio", e.target.value as AppSettings["aspectRatio"])}
              >
                <option value="9:16">9:16 vertical</option>
                <option value="1:1">1:1 square</option>
                <option value="16:9">16:9 landscape</option>
              </select>
            </Row>
            <Row label="Subtitle style" hint="Burned-in captions. Bold uses a heavy outline for mobile legibility.">
              <select
                className="select"
                value={s.subtitleStyle}
                onChange={(e) => set("subtitleStyle", e.target.value as AppSettings["subtitleStyle"])}
              >
                <option value="bold">Bold</option>
                <option value="clean">Clean</option>
                <option value="karaoke">Karaoke</option>
              </select>
            </Row>
            <Row
              label="Enlarge streamer webcam"
              hint="When Workers AI spots a face cam in the frame, the clip stacks a large face band above the gameplay. No face cam found means the normal layout is used."
            >
              <Switch on={s.webcamFocus} onChange={(v) => set("webcamFocus", v)} />
            </Row>
            <Row label="Frame sampling rate" hint="Frames per second sent to the vision model. Lower is cheaper; 0.5 means one frame every two seconds.">
              <input
                type="number"
                className="input"
                style={{ width: 76 }}
                min={0.1}
                max={4}
                step={0.1}
                value={s.frameSampleFps}
                onChange={(e) => set("frameSampleFps", Number(e.target.value))}
              />
            </Row>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="panel-title">
            <IconDatabase width={13} height={13} /> Storage &amp; quotas
          </h2>
          <Badge tone={stats.storageBytes / (s.storageLimitMb * 1024 * 1024) > 0.85 ? "red" : "green"}>
            {(stats.storageBytes / 1024 / 1024).toFixed(0)} MB used
          </Badge>
        </div>
        <div>
          <Row
            label="Storage limit"
            hint={`Rendering pauses when clips exceed this. The platform hard limit is 1 GB of R2 storage shared across all sites. Currently ${fmtBytes(stats.storageBytes)} in ${stats.clips} clips.`}
          >
            <input
              type="range"
              min={50}
              max={1000}
              step={50}
              value={s.storageLimitMb}
              onChange={(e) => set("storageLimitMb", Number(e.target.value))}
            />
            <span className="mono" style={{ width: 54, textAlign: "right" }}>{s.storageLimitMb} MB</span>
          </Row>
          <Row label="AI analysis" hint="Without Cloudflare Workers AI credentials, clips use the local heuristic scorer. That is real analysis of chat signals, but it cannot see the video.">
            <Badge tone={status.ai ? "green" : "amber"}>
              {status.ai ? `enabled · ${status.aiModel}` : "heuristic only"}
            </Badge>
          </Row>
          {status.ai ? (
            <Row
              label="Vision licence"
              hint="Meta's Llama vision model must be accepted once per Cloudflare account before it will describe frames. This sends that acceptance for you."
            >
              {licence ? (
                <span
                  style={{
                    fontSize: 11.5,
                    maxWidth: 220,
                    color: licence.startsWith("Accepted") ? "var(--green)" : "var(--red)",
                  }}
                >
                  {licence}
                </span>
              ) : null}
              <button className="btn ghost" onClick={acceptLicence} disabled={licensing}>
                {licensing ? "Accepting…" : licence?.startsWith("Accepted") ? "Accepted" : "Accept licence"}
              </button>
            </Row>
          ) : null}
          <Row label="Machine endpoints" hint="Collector and renderer authenticate with INGEST_TOKEN. Set it as a project secret.">
            <Badge tone={status.ingestToken ? "green" : "red"}>
              {status.ingestToken ? "token set" : "no token"}
            </Badge>
          </Row>
        </div>
      </section>

      {!status.ai || !status.ingestToken ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-body">
            <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <div className="empty-icon" style={{ margin: 0, width: 30, height: 30 }}>
                <IconAlert width={14} height={14} />
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.65 }}>
                <strong style={{ color: "var(--text)" }}>Optional upgrades.</strong>{" "}
                {!status.ingestToken
                  ? "Set INGEST_TOKEN to lock down the machine endpoints. "
                  : ""}
                {!status.ai
                  ? "Add CF_ACCOUNT_ID and CF_AI_TOKEN to enable Workers AI vision, Whisper transcription and LLM captions on the free daily neuron allowance. "
                  : ""}
                Everything keeps working without these, with the limitations labelled in the UI.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 10 }}>
        <button className="btn primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {dirty ? (
          <button className="btn ghost" onClick={() => setS(initial)}>
            Reset
          </button>
        ) : null}
        {toast ? (
          <span className="row" style={{ fontSize: 11.5, color: "var(--green)", gap: 5 }}>
            <IconCheck width={12} height={12} /> {toast}
          </span>
        ) : null}
      </div>
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        <div className="setting-hint">{hint}</div>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="switch"
      data-on={on}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      aria-label="toggle"
    />
  );
}

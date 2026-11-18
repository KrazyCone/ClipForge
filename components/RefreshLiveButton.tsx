"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh } from "./icons";

export function RefreshLiveButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/twitch/refresh", { method: "POST" });
      const data = (await res.json()) as { error?: string; updated?: number };
      if (!res.ok) setError(data.error ?? "Refresh failed");
      else router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row" style={{ gap: 8 }}>
      {error ? (
        <span className="faint" style={{ fontSize: 11, color: "var(--red)", maxWidth: 260 }}>
          {error}
        </span>
      ) : null}
      <button className="btn sm" onClick={refresh} disabled={busy}>
        <IconRefresh width={13} height={13} />
        {busy ? "Refreshing…" : "Refresh Twitch"}
      </button>
    </span>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh } from "./icons";

/** Refreshes server components on an interval and shows a live countdown. */
export function AutoRefresh({ intervalMs = 30000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(Math.round(intervalMs / 1000));

  useEffect(() => {
    const tick = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          router.refresh();
          return Math.round(intervalMs / 1000);
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [router, intervalMs]);

  return (
    <button
      className="btn sm ghost"
      onClick={() => {
        router.refresh();
        setSeconds(Math.round(intervalMs / 1000));
      }}
      title="Refresh data"
      style={{ gap: 6 }}
    >
      <IconRefresh width={13} height={13} />
      <span className="mono" style={{ fontSize: 11 }}>
        {seconds}s
      </span>
    </button>
  );
}

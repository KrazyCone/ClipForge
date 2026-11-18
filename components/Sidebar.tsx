"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconDatabase,
  IconFilm,
  IconGrid,
  IconPulse,
  IconRadio,
  IconSliders,
} from "./icons";

const NAV = [
  { href: "/", label: "Dashboard", icon: IconGrid },
  { href: "/live", label: "Live Monitor", icon: IconRadio },
  { href: "/clips", label: "Clip Library", icon: IconFilm },
  { href: "/channels", label: "Channels", icon: IconPulse },
  { href: "/settings", label: "Settings", icon: IconSliders },
];

export function Sidebar({
  storageUsed,
  storageLimit,
  clips,
}: {
  storageUsed: number;
  storageLimit: number;
  clips: number;
}) {
  const pathname = usePathname();
  const pct = storageLimit > 0 ? Math.min(100, (storageUsed / (storageLimit * 1024 * 1024)) * 100) : 0;
  const tone = pct > 90 ? "red" : pct > 70 ? "amber" : "green";

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">V</div>
        <div>
          <div className="brand-name">ClipForge</div>
          <div className="brand-tag">clip engine</div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-label">Workspace</div>
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className={`nav-item ${active ? "active" : ""}`}>
              <Icon />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <div className="quota-mini">
          <div className="spread" style={{ marginBottom: 6 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <IconDatabase width={12} height={12} />
              Storage
            </span>
            <strong>{pct.toFixed(0)}%</strong>
          </div>
          <div className={`bar ${tone}`} style={{ marginBottom: 6 }}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
            {(storageUsed / 1024 / 1024).toFixed(0)} / {storageLimit} MB · {clips} clips
          </div>
        </div>
      </div>
    </aside>
  );
}

import type { ReactNode } from "react";

export function Stat({
  label,
  value,
  foot,
  icon,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "",
  dot,
}: {
  children: ReactNode;
  tone?: "" | "live" | "neutral" | "green" | "amber" | "red";
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot ? <i className="dot" /> : null}
      {children}
    </span>
  );
}

export function Bar({
  value,
  max = 100,
  tone = "",
}: {
  value: number;
  max?: number;
  tone?: "" | "green" | "amber" | "red";
}) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className={`bar ${tone}`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function Score({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="faint">-</span>;
  const tone = value >= 80 ? "var(--green)" : value >= 60 ? "var(--text)" : "var(--text-dim)";
  return (
    <span className="score" style={{ color: tone }}>
      {value}
      <span>/100</span>
    </span>
  );
}

export function Avatar({ src, name }: { src?: string | null; name: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="avatar" src={src} alt="" loading="lazy" />;
  }
  return <div className="avatar fallback">{name.slice(0, 2)}</div>;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return "0:00";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 MB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ago(input: string | number | null | undefined): string {
  if (!input) return "never";
  const ts = typeof input === "number" ? input * 1000 : new Date(input).getTime();
  if (Number.isNaN(ts)) return "never";
  const diff = Math.max(0, Date.now() - ts) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

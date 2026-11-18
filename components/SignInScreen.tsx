import { SignInWithFreebuff } from "@freebuff/auth/react";

/** Full-page gate shown to signed-out visitors. */
export function SignInScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background:
          "var(--bg)",
      }}
    >
      <div style={{ width: "min(420px, 100%)" }}>
        <div className="row" style={{ gap: 10, marginBottom: 22 }}>
          <div className="brand-mark">V</div>
          <div>
            <div className="brand-name">ClipForge</div>
            <div className="brand-tag">clip engine</div>
          </div>
        </div>

        <h1 style={{ fontSize: 26, letterSpacing: "-0.03em", margin: "0 0 8px", fontWeight: 650 }}>
          Autonomous Twitch clipping
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13.5, lineHeight: 1.65, margin: "0 0 22px" }}>
          ClipForge watches chat, detects the moments that break pattern, scores them, and
          cuts vertical clips. Sign in to see the dashboard.
        </p>

        <div className="panel">
          <div className="panel-body" style={{ display: "grid", gap: 12 }}>
            <SignInWithFreebuff returnTo="/" className="btn primary">
              Sign in with Freebuff
            </SignInWithFreebuff>
            <p className="faint" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.6 }}>
              Your Freebuff account is used only to identify you. No password is created
              and no separate account is needed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import { getSettings } from "@/lib/db";
import { getStats } from "@/lib/queries";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SignInScreen } from "@/components/SignInScreen";
import { currentUser } from "@/lib/guard";
import { SignOutButton } from "@freebuff/auth/react";

export const metadata: Metadata = {
  title: "ClipForge — autonomous Twitch clipping",
  description:
    "ClipForge watches Twitch chat, detects the moments that matter, and turns them into vertical clips automatically.",
};

export const viewport: Viewport = {
  themeColor: "#07080b",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  if (!user) {
    return (
      <html lang="en">
        <body>
          <SignInScreen />
        </body>
      </html>
    );
  }

  const [settings, stats] = await Promise.all([getSettings(), getStats()]);

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar
            storageUsed={stats.storageBytes}
            storageLimit={settings.storageLimitMb}
            clips={stats.clips}
          />
          <main className="main">
            <header className="topbar">
              <div className="row" style={{ gap: 10 }}>
                <span className={`badge ${stats.liveChannels > 0 ? "live" : ""}`}>
                  {stats.liveChannels > 0 ? <i className="dot" /> : null}
                  {stats.liveChannels > 0 ? `${stats.liveChannels} live` : "idle"}
                </span>
                <span className="topbar-sub">
                  {stats.channelCount === 0
                    ? "No channels monitored yet"
                    : `${stats.channelCount} channels · ${stats.queueDepth} in queue`}
                </span>
              </div>
              <div className="topbar-actions">
                <AutoRefresh intervalMs={30000} />
                <span className="topbar-sub truncate" style={{ maxWidth: 160 }}>
                  {user.name ?? user.email ?? "signed in"}
                </span>
                <SignOutButton returnTo="/" className="btn sm ghost">
                  Sign out
                </SignOutButton>
              </div>
            </header>
            <div className="content">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}

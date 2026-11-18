import { getSettings } from "@/lib/db";
import { getAllFeedback, getStats } from "@/lib/queries";
import { getSystemStatus } from "@/lib/status";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, status, stats, feedback] = await Promise.all([
    getSettings(),
    getSystemStatus(),
    getStats(),
    getAllFeedback(),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-desc">
            Detection thresholds, render output and free-tier budgets. Changes apply on the
            collector&apos;s next cycle and to every render after you save.
          </p>
        </div>
      </div>

      <SettingsForm initial={settings} status={status} stats={stats} feedback={feedback} />
    </>
  );
}

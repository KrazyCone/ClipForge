import { getSettings } from "@/lib/db";
import { getRecentClips } from "@/lib/queries";
import { ClipLibrary } from "@/components/ClipLibrary";

export const dynamic = "force-dynamic";

export default async function ClipsPage({
  searchParams,
}: {
  searchParams: Promise<{ clip?: string; spike?: string }>;
}) {
  const params = await searchParams;
  const [clips, settings] = await Promise.all([getRecentClips(80), getSettings()]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Clip library</h1>
          <p className="page-desc">
            Every clip the pipeline produced, scored by the moment analyser. Download,
            re-caption or delete from here.
          </p>
        </div>
        <div className="row">
          <span className="badge neutral">{settings.aspectRatio} · 1080p</span>
          <span className="badge">floor {settings.minQualityScore}</span>
        </div>
      </div>

      <ClipLibrary
        initialClips={clips}
        initialClipId={params.clip ?? null}
        initialSpikeId={params.spike ?? null}
      />
    </>
  );
}

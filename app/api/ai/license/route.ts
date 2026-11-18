import { env } from "@/lib/db";
import { acceptVisionLicense } from "@/lib/ai";
import { denied } from "@/lib/guard";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Meta's Llama 3.2 vision model requires one licence acceptance per Cloudflare
 * account before it will answer. The Settings page calls this so the operator
 * never has to run curl, and so the acceptance is an explicit click rather than
 * something the pipeline does behind their back.
 */
export async function POST() {
  const gate = await denied();
  if (gate) return gate;

  const result = await acceptVisionLicense(await env());
  return json(result, result.ok ? 200 : 502);
}

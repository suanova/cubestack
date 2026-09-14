// /api/cubepilot/playground/services — the inference services the Playground
// tab can chat with (running ones, plus the ones still scaling).

import { listPlaygroundServices } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json(listPlaygroundServices());
});

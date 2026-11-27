import { withAuth } from "@/lib/auth/guard";
import { canEditBranding } from "@/lib/settings/branding";

// GET /api/auth/me
// Returns the authenticated caller's username and whether they may change
// platform settings. 401 when there is no valid session — the client uses this
// to decide between showing the portal and redirecting to /login.
export const GET = withAuth(async (_req, session) => {
  return Response.json({ user: session.user, isAdmin: canEditBranding(session.user) });
});

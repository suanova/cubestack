import { withAuth } from "@/lib/auth/guard";

// GET /api/auth/me
// Returns the authenticated caller's username. 401 when there is no valid
// session — the client uses this to decide between showing the portal and
// redirecting to /login.
export const GET = withAuth(async (_req, session) => {
  return Response.json({ user: session.user });
});
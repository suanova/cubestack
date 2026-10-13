import { SignJWT } from "jose";
import type { BrowserContext } from "@playwright/test";

// The e2e webServer (playwright.config.ts) boots the app with this fixed
// SESSION_SECRET so the specs can mint real signed session cookies for the
// pages to pass the auth guard/proxy. Keep the two in sync.
export const E2E_SESSION_SECRET = "e2e-session-secret";

const SESSION_COOKIE = "cubestack-session";

/**
 * Install a valid signed session cookie (user "admin") on the context so the
 * mocked-data page specs can navigate straight past the login redirect.
 *
 * `domain` is the host the cookie is scoped to. Suite A runs on localhost:3000
 * (the default); the integration suite reaches the portal through a
 * port-forward, so it passes whatever host its baseURL uses.
 */
export async function seedSession(context: BrowserContext, domain = "localhost"): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("admin")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(E2E_SESSION_SECRET));
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
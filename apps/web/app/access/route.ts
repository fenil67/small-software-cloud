/**
 * GET /access?app=<uuid>&state=<base64url>&return=<path>
 *
 * Login-hop handler for the per-app auth proxy.
 * Requires a signed-in Clerk user; validates params; exchanges a session token
 * for a one-time proxy code; redirects the user to the app's callback URL.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

// Never cached — this route performs live auth and issues one-time codes.
export const dynamic = "force-dynamic";

// ── Domain allowlist ──────────────────────────────────────────────────────────
// Only redirect to https URLs whose hostname ends with this suffix.
// Keeping the check in one place makes it easy to extend for future app domains.
const ALLOWED_APP_HOST_SUFFIX = ".fly.dev";

function isAllowedAppUrl(url: URL): boolean {
  return url.protocol === "https:" && url.hostname.endsWith(ALLOWED_APP_HOST_SUFFIX);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isValidState(s: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NO_STORE = "no-store";

function htmlResponse(body: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>SSC</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": NO_STORE,
      },
    },
  );
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  // 1. Require a signed-in Clerk user.
  const { userId, getToken, redirectToSignIn } = await auth();
  if (!userId) {
    return redirectToSignIn({ returnBackUrl: request.url });
  }

  // 2. Validate query params.
  const sp = request.nextUrl.searchParams;
  const app = sp.get("app") ?? "";
  const state = sp.get("state") ?? "";
  const returnPath = sp.get("return") ?? "";

  if (!isUuid(app) || !isValidState(state)) {
    return htmlResponse("<p>This link is invalid.</p>", 400);
  }

  // 3. Get the session token (never logged).
  const token = await getToken();
  if (!token) {
    return htmlResponse("<p>Something went wrong. Try again in a moment.</p>", 502);
  }

  // 4. Exchange with the API — POST to /v1/proxy/codes.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";
  let apiRes: globalThis.Response;
  try {
    apiRes = await fetch(`${apiUrl}/v1/proxy/codes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ app_id: app, state, return: returnPath }),
      cache: "no-store",
    });
  } catch {
    return htmlResponse("<p>Something went wrong. Try again in a moment.</p>", 502);
  }

  // 5. Handle API responses.
  if (apiRes.status === 201) {
    // Parse redirect_url — never log it.
    let redirectUrl: URL;
    try {
      const body = (await apiRes.json()) as { redirect_url?: string };
      if (!body.redirect_url) throw new Error("missing");
      redirectUrl = new URL(body.redirect_url);
    } catch {
      return htmlResponse("<p>Something went wrong. Try again in a moment.</p>", 502);
    }

    if (!isAllowedAppUrl(redirectUrl)) {
      return htmlResponse("<p>Something went wrong. Try again in a moment.</p>", 502);
    }

    return new Response(null, {
      status: 303,
      headers: {
        Location: redirectUrl.toString(),
        "Cache-Control": NO_STORE,
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  if (apiRes.status === 403) {
    let errorCode = "";
    try {
      const errBody = (await apiRes.json()) as { error?: string };
      errorCode = errBody.error ?? "";
    } catch { /* ignore parse errors */ }

    if (errorCode === "app_suspended") {
      return htmlResponse("<p>This app has been suspended by the platform.</p>", 403);
    }

    const user = await currentUser();
    const email = user?.primaryEmailAddress?.emailAddress ?? "";
    return htmlResponse(
      `<p>You don't have access to this app. Ask its owner to share it with you.</p>
       <p>Signed in as: ${escapeHtml(email)}</p>
       <p><a href="/sign-in">Use a different account</a></p>`,
      403,
    );
  }

  if (apiRes.status === 404) {
    return htmlResponse("<p>This app doesn't exist or was removed.</p>", 404);
  }

  return htmlResponse("<p>Something went wrong. Try again in a moment.</p>", 502);
}

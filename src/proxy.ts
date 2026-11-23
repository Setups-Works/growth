import { NextResponse, type NextRequest } from "next/server";
import { readPresentedKey, verifyApiKey, type Scope } from "@/lib/auth/api-key";
import { hasWhatsAppPlan } from "@/lib/billing/usage";
import { databaseConfigured } from "@/lib/db/client";
import { SCOPES_HEADER, USER_EMAIL_HEADER, USER_ID_HEADER } from "@/lib/auth/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/**
 * The single place a request is allowed in.
 *
 * This replaces `middleware.ts`, which Next 16 deprecated. The rename is not
 * cosmetic here: Proxy runs on the Node.js runtime, so this file can reach
 * Postgres directly to verify an API key. On the Edge runtime it could not,
 * and that check would have had to be repeated in twenty-eight route handlers
 * — where the first one anybody forgot would be a silent hole.
 *
 * ─── What it protects ──────────────────────────────────────────────────────
 *
 * Two layers, because they fail differently.
 *
 * The API requires a session or an API key. That is the layer that matters: it
 * is the response carrying the order history, and it is what an attacker would
 * request directly rather than by loading a page.
 *
 * The dashboard pages additionally require a session, and redirect to sign-in
 * without one. That is not what stops data leaking — the API check already
 * does — it is so a signed-out visitor never lands on an application shell
 * full of empty panels and failed requests, wondering what is broken.
 *
 * Marketing pages, sign-in, sign-up and the API reference stay open.
 *
 * A third layer, on top of those two: WHATSAPP_PAGES / WHATSAPP_API gate
 * WhatsApp-specific pages and routes behind `plan !== "lite"` (see
 * planIncludesWhatsApp in src/lib/billing/usage.ts). This is authorization,
 * not authentication — a deliberate widening of what this file does, made
 * here rather than at each of the dozen individual WhatsApp route handlers,
 * for the same reason the identity check itself lives in one place: a route
 * added later and not threaded through a per-handler check is a silent hole,
 * where a route not added to a list here is at least a visible omission to
 * grep for. The real backstop either way is planMessageLimit returning 0 for
 * Lite (checkSendAllowance, checked at every actual send site) — this layer
 * is about a Lite account never seeing or reaching the feature at all, not
 * the only thing preventing a message from going out.
 *
 * ─── Sessions ──────────────────────────────────────────────────────────────
 *
 * A session is a cookie signed with AUTH_SECRET (src/lib/auth/session.ts).
 * Verifying it is one HMAC — no database round trip — so checking it on
 * every request costs nothing worth measuring.
 */

/**
 * Paths that must stay reachable unauthenticated, and why. Anything not listed
 * needs a session or a key — the default is closed.
 */
const PUBLIC_API = new Set([
  // The store calls this one, not a browser, and it authenticates itself with
  // the signed state we issued — which is also the only thing that says whose
  // account the store attaches to.
  "/api/auth/woo/callback",
  // The browser legs of the connect flow.
  "/api/auth/woo/start",
  "/api/auth/woo/return",
  // Reports whether you are signed in. Gating it would be circular.
  "/api/auth/session",
  // Health probe for Docker and load balancers. Says only "up" or "down".
  "/api/health",
  // Describes the API's shape. No store data, no credentials — and it is what
  // a developer reads to find out how to authenticate in the first place.
  "/api/openapi",
  // Authenticates with CRON_SECRET itself, checked in the handler. The
  // scheduler has no session and no key.
  "/api/cron/flows",
  "/api/cron/sync",
  "/api/cron/abandoned-checkouts",
  // Server-to-server from Razorpay, verified via an HMAC signature
  // (RAZORPAY_WEBHOOK_SECRET) inside the handler, not a session or key.
  "/api/billing/webhook",
  // Signing in, up and out, and recovering a password. Each authenticates
  // the caller itself (password, or a one-time reset token) and is rate
  // limited in its handler. /api/auth/password is deliberately NOT here: it
  // changes the password of whoever is already signed in.
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/forgot",
  "/api/auth/reset",
]);

/**
 * Endpoints that are POSTs but change nothing a merchant would miss.
 *
 * Mapping scope to method alone would demand a write key to export a report,
 * which is wrong: these read and render. Listed rather than inferred, because
 * the list is short and the inference would be wrong in both directions.
 *
 * `/api/ai/chat` is here on the same reasoning — it answers questions about
 * existing data. Note it does bill against GROQ_API_KEY, so a read key can
 * cost money even though it cannot change anything.
 */
const READ_ONLY_POSTS = new Set([
  "/api/reports/export",
  "/api/whatsapp/preview",
  "/api/ai/chat",
]);

function scopeFor(pathname: string, method: string): Scope {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
  return READ_ONLY_POSTS.has(pathname) ? "read" : "write";
}

function deny(status: number, error: string, hint: string) {
  return NextResponse.json(
    { error, hint, docs: "/api-docs" },
    {
      status,
      // Tells a client library which scheme to retry with, instead of leaving
      // it to guess from a bare 401.
      headers: { "WWW-Authenticate": 'Bearer realm="Setups Works Growth API"' },
    },
  );
}

/**
 * Pages that require a session. Everything not listed — marketing, sign-in,
 * sign-up, the API reference — is open.
 */
const PROTECTED_PAGES = [
  "/dashboard",
  "/forecast",
  "/customers",
  "/acquisition",
  "/cohorts",
  "/products",
  "/inventory",
  "/orders",
  "/campaigns",
  "/reports",
  "/settings",
  "/assistant",
  "/inbox",
  "/flows",
  "/abandoned-checkouts",
  "/order-confirmations",
  "/whatsapp-cloud-pilot",
  "/menu",
  "/connect",
  "/onboarding",
];

/** Pages a Lite account (analytics only) is redirected away from. */
const WHATSAPP_PAGES = [
  "/campaigns",
  "/flows",
  "/abandoned-checkouts",
  "/order-confirmations",
  "/menu",
  "/inbox",
  "/whatsapp-cloud-pilot",
  "/assistant",
];

/**
 * API prefixes gated the same way, for both a session and an API key.
 * /api/ai/chat is included alongside the /api/whatsapp* prefixes because
 * /assistant is gated above — its own value (asking questions, drafting
 * messages) is inseparable from the WhatsApp actions it proposes, so it's
 * gated as a whole rather than trying to allow read-only questions through
 * while blocking only the send proposals.
 */
const WHATSAPP_API_PREFIXES = ["/api/whatsapp", "/api/whatsapp-cloud", "/api/ai/chat"];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Null when the request may proceed; a ready-to-return response otherwise. */
async function whatsappPlanGate(userId: string): Promise<NextResponse | null> {
  if (await hasWhatsAppPlan(userId)) return null;
  return NextResponse.json(
    {
      error: "This plan does not include WhatsApp.",
      hint: "Upgrade to Go or Plus in Settings → Billing to use WhatsApp features.",
    },
    { status: 402 },
  );
}

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });

  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  const user = session ? { id: session.userId, email: session.email } : null;

  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) {
    /*
     * One public address. A deployment reachable under two hostnames (a
     * custom domain and *.azurewebsites.net) splits sessions: the login
     * cookie belongs to one host, and a redirect back from WooCommerce to the
     * other lands signed out. Page visits on any other host are sent to
     * APP_URL's; the API is left alone so health probes and callbacks work.
     */
    const canonical = canonicalRedirect(request);
    if (canonical) return canonical;

    /*
     * Signing in is not something you can do while signed in. Leaving the form
     * reachable means someone lands on it, cannot tell whether they are logged
     * in, and signs in again to find out.
     */
    if (user && (pathname === "/login" || pathname === "/signup")) {
      const next = request.nextUrl.searchParams.get("next");
      const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      return NextResponse.redirect(new URL(safe, request.url));
    }

    const isProtected = PROTECTED_PAGES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );

    if (isProtected && user && databaseConfigured() && matchesPrefix(pathname, WHATSAPP_PAGES)) {
      const included = await hasWhatsAppPlan(user.id);
      if (!included) {
        return NextResponse.redirect(new URL("/settings?section=billing&upgrade=whatsapp", request.url));
      }
    }

    if (!isProtected || user) return response;

    /*
     * Remember where they were headed so signing in returns them there rather
     * than dumping everyone on the dashboard. Includes the query string, read
     * back through a path-only check on the other side (see auth-form.tsx)
     * because a value from a URL is attacker-controllable and an absolute one
     * would turn sign-in into an open redirect.
     */
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  if (PUBLIC_API.has(pathname)) return response;

  /*
   * A dynamic `[storeId]` segment can't live in PUBLIC_API's exact-match set.
   * This is genuinely public the same way /api/billing/webhook is: verified
   * per-store by an HMAC signature inside the handler itself, not by session
   * or key — see src/app/api/webhooks/woo/[storeId]/order-created/route.ts.
   */
  if (pathname.startsWith("/api/webhooks/woo/")) return response;

  /*
   * Without a database nothing can be verified, and serving the order history
   * to the open internet is not an acceptable failure mode. This is the shape
   * of the bug that put real customer data on a public URL: "misconfigured"
   * must never read the same as "no auth wanted".
   */
  if (!databaseConfigured()) {
    return deny(
      503,
      "This deployment cannot authenticate requests.",
      "DATABASE_URL is not set, so API keys cannot be checked.",
    );
  }

  if (user) {
    if (matchesPrefix(pathname, WHATSAPP_API_PREFIXES)) {
      const deniedForSession = await whatsappPlanGate(user.id);
      if (deniedForSession) return deniedForSession;
    }
    return forward(request, user.id, user.email);
  }

  const presented = readPresentedKey(request.headers);
  if (!presented) {
    return deny(
      401,
      "Authentication required.",
      "Sign in, or send an API key as `Authorization: Bearer sw_live_…`. Create one in Settings → API keys.",
    );
  }

  const key = await verifyApiKey(presented);
  if (!key) {
    return deny(
      401,
      "That API key is not valid.",
      "It may have been revoked, or mistyped. Keys start with `sw_live_`.",
    );
  }

  const needed = scopeFor(pathname, request.method);
  if (!key.scopes.includes(needed)) {
    return deny(
      403,
      `This key does not have the "${needed}" scope.`,
      `"${key.name}" is limited to: ${key.scopes.join(", ")}. Issue a key with the "${needed}" scope to call this endpoint.`,
    );
  }

  if (matchesPrefix(pathname, WHATSAPP_API_PREFIXES)) {
    const denied = await whatsappPlanGate(key.userId);
    if (denied) return denied;
  }

  return forward(request, key.userId, key.ownerEmail ?? "", key.scopes);
}

/**
 * Passes the verified caller to the handler.
 *
 * Proxy has already verified the caller, and without this every handler
 * would have to do it again.
 *
 * Anything arriving under these names is deleted first. They come from the
 * public internet, and a handler must not be able to be told who it is talking
 * to by the request itself.
 */
function forward(request: NextRequest, userId: string, email: string, scopes?: Scope[]) {
  const headers = new Headers(request.headers);
  headers.delete(USER_ID_HEADER);
  headers.delete(USER_EMAIL_HEADER);
  headers.delete(SCOPES_HEADER);
  headers.set(USER_ID_HEADER, userId);
  headers.set(USER_EMAIL_HEADER, email);
  // Only set for a key. Its absence is how a handler tells a session — which
  // may do anything — from a key that may not.
  if (scopes) headers.set(SCOPES_HEADER, scopes.join(","));
  return NextResponse.next({ request: { headers } });
}

function canonicalRedirect(request: NextRequest): NextResponse | null {
  const appUrl = process.env.APP_URL;
  if (process.env.NODE_ENV !== "production" || !appUrl?.startsWith("https://")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let target: URL;
  try {
    target = new URL(appUrl);
  } catch {
    return null;
  }
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
  if (!host || host === target.host || host.startsWith("localhost") || host.startsWith("127.0.0.1")) return null;
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, target);
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. The API is included
     * on purpose — its absence from the old matcher is what left it open.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};

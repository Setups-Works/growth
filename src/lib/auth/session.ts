/**
 * Signed session cookie — the whole of browser authentication.
 *
 * A session is `<base64url payload>.<base64url HMAC-SHA256>`, signed with
 * AUTH_SECRET. There is no session table: verifying one is a single HMAC, so
 * Proxy can check every request without a database round trip.
 *
 * Uses Web Crypto rather than `node:crypto` so the same code runs anywhere.
 */

export const SESSION_COOKIE = "sw_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (value && value.length >= 16) return value;
  // A weak fallback would silently make sessions forgeable, so refuse instead.
  throw new Error(
    "AUTH_SECRET is not set (or is shorter than 16 characters). Generate one with `openssl rand -hex 32`.",
  );
}

/** True when the deployment can issue sessions at all. */
export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16);
}

function base64url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSession(payload: { userId: string; email: string }): Promise<string> {
  const now = Date.now();
  const full: SessionPayload = { ...payload, issuedAt: now, expiresAt: now + SESSION_TTL_MS };
  const body = base64url(new TextEncoder().encode(JSON.stringify(full)));
  const signature = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token || !authConfigured()) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(),
      fromBase64url(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(fromBase64url(body)))) as SessionPayload;
    if (typeof payload.userId !== "string" || typeof payload.expiresAt !== "number") return null;
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/*
 * `secure` follows APP_URL rather than NODE_ENV: a Docker container is always
 * NODE_ENV=production, but may legitimately be reached over plain HTTP on a
 * private network or localhost, where a Secure cookie would be dropped.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
  secure: (process.env.APP_URL ?? "").startsWith("https://"),
};

/**
 * A tiny fixed-window rate limiter for the sign-in, sign-up and reset
 * endpoints, so a password can't be guessed at network speed.
 *
 * In-memory, per process. That is exactly right for the single-container
 * deployment this app ships as; behind several replicas each gets its own
 * budget, which weakens the limit by that factor but never breaks anything.
 */

const buckets = new Map<string, { count: number; resetAt: number }>();

/** True when the call is allowed; false once `limit` is exceeded in the window. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  // Opportunistic sweep so the map can't grow without bound.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= limit;
}

/** Best-effort client address, for keying the limiter. */
export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function tooMany(): Response {
  return Response.json(
    { error: "Too many attempts. Wait a few minutes and try again." },
    { status: 429, headers: { "Retry-After": "300" } },
  );
}

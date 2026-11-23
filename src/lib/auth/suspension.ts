import { db, databaseConfigured } from "@/lib/db/client";

/**
 * Whether an account has been suspended from the admin panel.
 *
 * Sessions are stateless signed cookies, so a suspension has to be checked
 * somewhere on each request or an already-signed-in user would keep working
 * for up to 30 days. Proxy calls this for every authenticated request; the
 * answer is cached per process for a short time so that costs one query per
 * user per minute, not one per request. Suspending clears the cache entry in
 * this process at once (the app runs as a single instance).
 */

const TTL_MS = 60_000;
type Cache = Map<string, { at: number; suspended: boolean }>;
const g = globalThis as typeof globalThis & { __growthSuspended?: Cache };
const cache: Cache = (g.__growthSuspended ??= new Map());

export async function isSuspended(userId: string): Promise<boolean> {
  if (!databaseConfigured()) return false;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.suspended;
  try {
    const [row] = await db()<{ suspended_at: Date | null }[]>`select suspended_at from users where id = ${userId}`;
    const suspended = Boolean(row?.suspended_at);
    cache.set(userId, { at: Date.now(), suspended });
    if (cache.size > 10_000) cache.clear();
    return suspended;
  } catch {
    // Unreachable database: fail open here; every data route fails anyway.
    return false;
  }
}

export function forgetSuspension(userId: string): void {
  cache.delete(userId);
}

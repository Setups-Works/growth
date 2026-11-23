import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db, databaseConfigured } from "@/lib/db/client";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, verifySession } from "./session";

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * The signed-in user, or null — for server components and route handlers
 * that Proxy does not forward a verified identity to.
 *
 * Verifies the cookie's signature, then confirms the account still exists:
 * a deleted user's unexpired cookie must not keep working.
 */
export async function currentUser(): Promise<CurrentUser | null> {
  try {
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session || !databaseConfigured()) return null;

    const [row] = await db()<{ id: string; email: string; full_name: string | null; avatar_url: string | null }[]>`
      select u.id, u.email, p.full_name, p.avatar_url
      from users u left join profiles p on p.id = u.id
      where u.id = ${session.userId}
    `;
    if (!row) return null;
    return { id: row.id, email: row.email, name: row.full_name, avatarUrl: row.avatar_url };
  } catch {
    return null;
  }
}

/** A JSON response that also signs the given user in. */
export async function withSession(
  user: { id: string; email: string },
  body: Record<string, unknown> = { ok: true },
): Promise<NextResponse> {
  const response = NextResponse.json(body);
  response.cookies.set(SESSION_COOKIE, await createSession({ userId: user.id, email: user.email }), SESSION_COOKIE_OPTIONS);
  return response;
}

import { db } from "@/lib/db/client";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { rateLimit, tooMany } from "@/lib/auth/rate-limit";
import { requireTenant } from "@/lib/auth/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Changes the signed-in user's password. Requires the current one: an
 * unattended session on a shared device must not be enough to lock the owner
 * out. Browser sessions only — an API key cannot change a password.
 */
export async function POST(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { userId, via } = resolved.value;
  if (via !== "session") {
    return Response.json({ error: "Sign in in a browser to change your password." }, { status: 403 });
  }
  if (!rateLimit(`password:${userId}`, 10, 15 * 60 * 1000)) return tooMany();

  const body = (await request.json().catch(() => ({}))) as { current?: unknown; next?: unknown };
  const problem = passwordProblem(body.next);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const [user] = await db()<{ password_hash: string }[]>`select password_hash from users where id = ${userId}`;
  if (!user || typeof body.current !== "string" || !(await verifyPassword(body.current, user.password_hash))) {
    return Response.json({ error: "Current password is incorrect." }, { status: 400 });
  }

  const hash = await hashPassword(body.next as string);
  await db()`update users set password_hash = ${hash}, updated_at = now() where id = ${userId}`;
  return Response.json({ ok: true });
}

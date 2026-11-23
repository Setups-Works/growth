import { createHash } from "node:crypto";
import { db, databaseConfigured } from "@/lib/db/client";
import { withSession } from "@/lib/auth/current-user";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { clientIp, rateLimit, tooMany } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sets a new password from a reset link, then signs the user in. The token is
 * consumed in the same statement that checks it, so it works exactly once
 * even if two requests race.
 */
export async function POST(request: Request) {
  if (!databaseConfigured()) {
    return Response.json({ error: "This server is missing DATABASE_URL." }, { status: 503 });
  }
  if (!rateLimit(`reset:${clientIp(request)}`, 20, 15 * 60 * 1000)) return tooMany();

  const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    return Response.json({ error: "This reset link is invalid." }, { status: 400 });
  }
  const problem = passwordProblem(body.password);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const digest = createHash("sha256").update(body.token).digest("hex");
  const hash = await hashPassword(body.password as string);

  const user = await db().begin(async (tx) => {
    const [reset] = await tx<{ user_id: string }[]>`
      update password_resets set used_at = now()
      where token_hash = ${digest} and used_at is null and expires_at > now()
      returning user_id
    `;
    if (!reset) return null;
    // Any other outstanding links for this account are now moot.
    await tx`update password_resets set used_at = now() where user_id = ${reset.user_id} and used_at is null`;
    const [row] = await tx<{ id: string; email: string }[]>`
      update users set password_hash = ${hash}, updated_at = now()
      where id = ${reset.user_id}
      returning id, email
    `;
    return row ?? null;
  });

  if (!user) {
    return Response.json({ error: "This reset link has expired or was already used. Request a new one." }, { status: 400 });
  }
  return withSession(user);
}

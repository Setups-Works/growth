import { db, databaseConfigured } from "@/lib/db/client";
import { withSession } from "@/lib/auth/current-user";
import { hashPassword, normaliseEmail, passwordProblem } from "@/lib/auth/password";
import { clientIp, rateLimit, tooMany } from "@/lib/auth/rate-limit";
import { authConfigured } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Creates an account and signs it in. Disabled when DISABLE_SIGNUPS=true. */
export async function POST(request: Request) {
  if (process.env.DISABLE_SIGNUPS === "true") {
    return Response.json({ error: "Sign-ups are closed on this server." }, { status: 403 });
  }
  if (!databaseConfigured() || !authConfigured()) {
    return Response.json({ error: "This server is missing DATABASE_URL or AUTH_SECRET." }, { status: 503 });
  }
  if (!rateLimit(`signup:${clientIp(request)}`, 10, 60 * 60 * 1000)) return tooMany();

  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = normaliseEmail(body.email);
  if (!email) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  const problem = passwordProblem(body.password);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const hash = await hashPassword(body.password as string);
  const [user] = await db()<{ id: string; email: string }[]>`
    insert into users (email, password_hash) values (${email}, ${hash})
    on conflict ((lower(email))) do nothing
    returning id, email
  `;
  if (!user) {
    return Response.json({ error: "An account with this email already exists. Sign in instead." }, { status: 409 });
  }
  return withSession(user);
}

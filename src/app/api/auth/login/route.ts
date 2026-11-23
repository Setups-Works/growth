import { db, databaseConfigured } from "@/lib/db/client";
import { withSession } from "@/lib/auth/current-user";
import { normaliseEmail, verifyPassword } from "@/lib/auth/password";
import { clientIp, rateLimit, tooMany } from "@/lib/auth/rate-limit";
import { authConfigured } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Verified against a real hash even when the account doesn't exist, so the
 * response time doesn't reveal which emails have accounts.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export async function POST(request: Request) {
  if (!databaseConfigured() || !authConfigured()) {
    return Response.json({ error: "This server is missing DATABASE_URL or AUTH_SECRET." }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = normaliseEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });

  if (
    !rateLimit(`login-ip:${clientIp(request)}`, 30, 15 * 60 * 1000) ||
    !rateLimit(`login-email:${email}`, 10, 15 * 60 * 1000)
  ) {
    return tooMany();
  }

  const [user] = await db()<{ id: string; email: string; password_hash: string; suspended_at: Date | null }[]>`
    select id, email, password_hash, suspended_at from users where lower(email) = ${email}
  `;
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return Response.json({ error: "Incorrect email or password." }, { status: 401 });
  if (user.suspended_at) {
    return Response.json({ error: "This account has been suspended. Contact support." }, { status: 403 });
  }

  return withSession(user);
}

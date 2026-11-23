import { createHash, randomBytes } from "node:crypto";
import { db, databaseConfigured } from "@/lib/db/client";
import { normaliseEmail } from "@/lib/auth/password";
import { clientIp, rateLimit, tooMany } from "@/lib/auth/rate-limit";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MINUTES = 60;

/**
 * Emails a one-time reset link. Always answers the same way whether or not
 * the address has an account, so this can't be used to discover who signed
 * up. Only a SHA-256 digest of the token is stored.
 */
export async function POST(request: Request) {
  if (!databaseConfigured()) {
    return Response.json({ error: "This server is missing DATABASE_URL." }, { status: 503 });
  }
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = normaliseEmail(body.email);
  if (!email) return Response.json({ error: "Enter a valid email address." }, { status: 400 });

  if (!rateLimit(`forgot-ip:${clientIp(request)}`, 10, 60 * 60 * 1000) || !rateLimit(`forgot:${email}`, 3, 60 * 60 * 1000)) {
    return tooMany();
  }

  const [user] = await db()<{ id: string; email: string }[]>`select id, email from users where lower(email) = ${email}`;
  if (user) {
    const token = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(token).digest("hex");
    await db()`
      insert into password_resets (token_hash, user_id, expires_at)
      values (${digest}, ${user.id}, now() + make_interval(mins => ${TTL_MINUTES}))
    `;
    const base = (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
    const link = `${base}/reset-password?token=${token}`;
    try {
      await sendEmail(
        user.email,
        "Reset your Setups Works Growth password",
        `Someone asked to reset the password for this Setups Works Growth account.\n\nSet a new password (link valid for ${TTL_MINUTES} minutes, works once):\n${link}\n\nIf this wasn't you, ignore this email.`,
      );
    } catch (error) {
      console.error("[forgot-password] could not send email:", error);
    }
  }

  return Response.json({ ok: true });
}

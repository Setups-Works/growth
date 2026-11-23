import { db, databaseConfigured } from "@/lib/db/client";
import { withSession } from "@/lib/auth/current-user";
import { hashPassword, normaliseEmail, passwordProblem } from "@/lib/auth/password";
import { clientIp, rateLimit, tooMany } from "@/lib/auth/rate-limit";
import { authConfigured } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { normaliseName, normalisePhone } from "@/lib/auth/fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Creates an account and signs it in. Disabled by DISABLE_SIGNUPS=true or from Admin → Settings. */
export async function POST(request: Request) {
  if (process.env.DISABLE_SIGNUPS === "true" || !(await getSettings()).signupsEnabled) {
    return Response.json({ error: "Sign-ups are closed on this server." }, { status: 403 });
  }
  if (!databaseConfigured() || !authConfigured()) {
    return Response.json({ error: "This server is missing DATABASE_URL or AUTH_SECRET." }, { status: 503 });
  }
  if (!rateLimit(`signup:${clientIp(request)}`, 10, 60 * 60 * 1000)) return tooMany();

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    password?: unknown;
  };
  const name = normaliseName(body.name);
  if (!name) return Response.json({ error: "Enter your full name.", field: "name" }, { status: 400 });
  const email = normaliseEmail(body.email);
  if (!email) return Response.json({ error: "Enter a valid email address.", field: "email" }, { status: 400 });
  const phone = normalisePhone(body.phone);
  if (!phone) {
    return Response.json(
      { error: "Enter a valid mobile number, e.g. 98765 43210 or +44 7700 900123.", field: "phone" },
      { status: 400 },
    );
  }
  const problem = passwordProblem(body.password);
  if (problem) return Response.json({ error: problem, field: "password" }, { status: 400 });

  const hash = await hashPassword(body.password as string);
  const [user] = await db()<{ id: string; email: string }[]>`
    insert into users (email, password_hash) values (${email}, ${hash})
    on conflict ((lower(email))) do nothing
    returning id, email
  `;
  if (!user) {
    return Response.json(
      { error: "An account with this email already exists. Sign in instead.", field: "email" },
      { status: 409 },
    );
  }
  // The profile row is created by a trigger on users; fill in who they are.
  await db()`
    insert into profiles (id, email, full_name, phone) values (${user.id}, ${user.email}, ${name}, ${phone})
    on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone
  `;
  return withSession(user);
}

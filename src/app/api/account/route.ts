import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/current-user";
import { normaliseName, normalisePhone } from "@/lib/auth/fields";
import { normaliseEmail, verifyPassword } from "@/lib/auth/password";
import { rateLimit, tooMany } from "@/lib/auth/rate-limit";
import { requireTenant } from "@/lib/auth/tenant";
import { syncCustomer } from "@/lib/billing/razorpay";
import { billingEnforced } from "@/lib/billing/usage";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AccountRow {
  id: string;
  email: string;
  created_at: Date;
  full_name: string | null;
  phone: string | null;
  plan: string | null;
  subscription_status: string | null;
  razorpay_customer_id: string | null;
}

async function load(userId: string) {
  const [row] = await db()<AccountRow[]>`
    select u.id, u.email, u.created_at, p.full_name, p.phone, p.plan, p.subscription_status, p.razorpay_customer_id
    from users u left join profiles p on p.id = u.id where u.id = ${userId}`;
  const [stores] = await db()<{ n: number }[]>`select count(*)::int as n from stores where user_id = ${userId}`;
  return { row, stores: stores.n };
}

/** The signed-in person's own details — the profile page reads this. */
export async function GET(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { row, stores } = await load(resolved.value.userId);
  if (!row) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  return NextResponse.json({
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    createdAt: row.created_at.toISOString(),
    plan: row.plan,
    subscriptionStatus: row.subscription_status ?? "none",
    stores,
  });
}

/**
 * Updates your name, mobile number or email. Browser sessions only. A new
 * email also needs the current password — it's the address password resets
 * go to, so changing it is as sensitive as changing the password. Name and
 * phone are copied to the Razorpay customer too, so receipts and card OTPs
 * use the current details.
 */
export async function PATCH(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { userId, via } = resolved.value;
  if (via !== "session") {
    return NextResponse.json({ error: "Sign in in a browser to change your details." }, { status: 403 });
  }
  if (!rateLimit(`account:${userId}`, 20, 15 * 60 * 1000)) return tooMany();

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    currentPassword?: unknown;
  };
  const { row } = await load(userId);
  if (!row) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const name = body.name === undefined ? row.full_name : normaliseName(body.name);
  if (body.name !== undefined && !name) {
    return NextResponse.json({ error: "Enter your full name.", field: "name" }, { status: 400 });
  }
  const phone = body.phone === undefined ? row.phone : normalisePhone(body.phone);
  if (body.phone !== undefined && !phone) {
    return NextResponse.json({ error: "Enter a valid mobile number.", field: "phone" }, { status: 400 });
  }

  let email = row.email;
  if (body.email !== undefined) {
    const wanted = normaliseEmail(body.email);
    if (!wanted) return NextResponse.json({ error: "Enter a valid email address.", field: "email" }, { status: 400 });
    if (wanted !== row.email.toLowerCase()) {
      const [auth] = await db()<{ password_hash: string }[]>`select password_hash from users where id = ${userId}`;
      if (typeof body.currentPassword !== "string" || !(await verifyPassword(body.currentPassword, auth.password_hash))) {
        return NextResponse.json(
          { error: "Enter your current password to change your email.", field: "currentPassword" },
          { status: 400 },
        );
      }
      const [taken] = await db()`select 1 from users where lower(email) = ${wanted} and id <> ${userId}`;
      if (taken) return NextResponse.json({ error: "Another account already uses this email.", field: "email" }, { status: 409 });
      email = wanted;
    }
  }

  const emailChanged = email !== row.email;
  await db().begin(async (sql) => {
    if (emailChanged) await sql`update users set email = ${email}, updated_at = now() where id = ${userId}`;
    await sql`
      insert into profiles (id, email, full_name, phone) values (${userId}, ${email}, ${name}, ${phone})
      on conflict (id) do update set email = excluded.email, full_name = excluded.full_name, phone = excluded.phone`;
  });

  if (row.razorpay_customer_id && billingEnforced()) {
    await syncCustomer(row.razorpay_customer_id, {
      name: name ?? undefined,
      contact: phone ?? undefined,
      ...(emailChanged ? { email } : {}),
    });
  }

  const result = { ok: true, name, email, phone };
  // The session cookie carries the email; re-issue it so the app shows the new one at once.
  return emailChanged ? withSession({ id: userId, email }, result) : NextResponse.json(result);
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { adminEmails, audit, requireAdmin } from "@/lib/auth/admin";
import { forgetSuspension } from "@/lib/auth/suspension";
import { cancelSubscription } from "@/lib/billing/razorpay";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/** Admin: one account in full — plan, stores, usage, invoices, history. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const sql = db();

  const [user] = await sql<
    {
      id: string;
      email: string;
      created_at: Date;
      is_admin: boolean;
      suspended_at: Date | null;
      name: string | null;
      phone: string | null;
      plan: string | null;
      subscription_status: string | null;
      razorpay_customer_id: string | null;
      razorpay_subscription_id: string | null;
      current_period_end: Date | null;
      grace_until: Date | null;
      legacy_unlimited: boolean | null;
      trial_ends_at: Date | null;
      trial_used_at: Date | null;
      comp_until: Date | null;
      onboarded_at: Date | null;
    }[]
  >`
    select u.id, u.email, u.created_at, u.is_admin, u.suspended_at, p.full_name as name, p.phone, p.plan,
           p.subscription_status, p.razorpay_customer_id, p.razorpay_subscription_id, p.current_period_end,
           p.grace_until, p.legacy_unlimited, p.trial_ends_at, p.trial_used_at, p.comp_until, p.onboarded_at
    from users u left join profiles p on p.id = u.id where u.id = ${id}`;
  if (!user) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const [stores, usage, invoices, [keys], history] = await Promise.all([
    sql`select id, url, name, order_count, customer_count, product_count, last_sync_at, backfill_done, created_at
        from stores where user_id = ${id} order by created_at`,
    sql`select period, sent_count from whatsapp_usage where user_id = ${id} order by period desc limit 6`,
    sql`select id, plan, amount_paise, currency, status, paid_at from billing_invoices
        where user_id = ${id} order by paid_at desc limit 24`,
    sql<{ n: number }[]>`select count(*)::int as n from api_keys where user_id = ${id} and revoked_at is null`,
    sql`select admin_email, action, detail, created_at from admin_audit where target = ${id}
        order by created_at desc limit 20`,
  ]);

  const reg = (globalThis as { __growthWhatsApp?: { sessions: Map<string, { toJSON(): unknown }> } }).__growthWhatsApp;
  const whatsapp = reg?.sessions.get(id)?.toJSON() ?? null;

  return NextResponse.json({
    user: { ...user, envAdmin: adminEmails().includes(user.email.toLowerCase()) },
    stores,
    usage,
    invoices,
    apiKeys: keys.n,
    whatsapp,
    history,
  });
}

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant_plan"), plan: z.enum(["lite", "go", "plus"]), days: z.number().int().min(1).max(3650) }),
  z.object({ action: z.literal("clear_plan") }),
  z.object({ action: z.literal("set_unlimited"), value: z.boolean() }),
  z.object({ action: z.literal("reset_usage") }),
  z.object({ action: z.literal("reset_trial") }),
  z.object({ action: z.literal("cancel_subscription") }),
  z.object({ action: z.literal("set_admin"), value: z.boolean() }),
  z.object({ action: z.literal("suspend"), value: z.boolean() }),
]);

/** Admin: change one account. Every change is written to the audit log. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const { admin } = gate;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const parsed = action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown or malformed action." }, { status: 422 });
  const body = parsed.data;
  const sql = db();

  const [target] = await sql<{ email: string; razorpay_subscription_id: string | null }[]>`
    select u.email, p.razorpay_subscription_id from users u left join profiles p on p.id = u.id where u.id = ${id}`;
  if (!target) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Locking yourself out is never what was meant.
  if (id === admin.id && ((body.action === "set_admin" && !body.value) || (body.action === "suspend" && body.value))) {
    return NextResponse.json({ error: "You can't remove your own admin access or suspend yourself." }, { status: 400 });
  }

  // Older accounts may predate their profile row.
  await sql`insert into profiles (id, email) values (${id}, ${target.email}) on conflict (id) do nothing`;

  switch (body.action) {
    case "grant_plan":
      await sql`
        update profiles set plan = ${body.plan}, comp_until = now() + make_interval(days => ${body.days}),
               grace_until = null, updated_at = now()
        where id = ${id}`;
      break;
    case "clear_plan":
      await sql`
        update profiles set plan = null, subscription_status = 'none', comp_until = null, grace_until = null,
               trial_ends_at = null, updated_at = now()
        where id = ${id}`;
      break;
    case "set_unlimited":
      await sql`update profiles set legacy_unlimited = ${body.value}, updated_at = now() where id = ${id}`;
      break;
    case "reset_usage":
      await sql`delete from whatsapp_usage where user_id = ${id} and period = ${new Date().toISOString().slice(0, 7)}`;
      break;
    case "reset_trial":
      await sql`update profiles set trial_used_at = null, updated_at = now() where id = ${id}`;
      break;
    case "cancel_subscription":
      if (target.razorpay_subscription_id) {
        try {
          await cancelSubscription(target.razorpay_subscription_id);
        } catch (e) {
          const description = (e as { error?: { description?: string } })?.error?.description;
          // Already cancelled on Razorpay's side is fine; anything else is reported.
          if (description && !/cancel/i.test(description)) {
            return NextResponse.json({ error: `Razorpay: ${description}` }, { status: 502 });
          }
        }
      }
      await sql`update profiles set subscription_status = 'cancelled', grace_until = null, updated_at = now() where id = ${id}`;
      break;
    case "set_admin":
      await sql`update users set is_admin = ${body.value}, updated_at = now() where id = ${id}`;
      break;
    case "suspend":
      await sql`update users set suspended_at = ${body.value ? sql`now()` : null}, updated_at = now() where id = ${id}`;
      forgetSuspension(id);
      break;
  }

  await audit(admin, body.action, id, { ...body, email: target.email });
  return NextResponse.json({ ok: true });
}

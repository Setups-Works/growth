import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getPlanCatalog } from "@/lib/billing/catalog";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: the whole server at a glance — accounts, revenue, usage, stores. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const sql = db();
  const period = new Date().toISOString().slice(0, 7);

  const [[users], [stores], subs, [revenue], [messages], [webhooks], signups, recent, catalog] = await Promise.all([
    sql<{ total: number; d7: number; d30: number; admins: number; suspended: number }[]>`
      select count(*)::int as total,
             count(*) filter (where created_at > now() - interval '7 days')::int as d7,
             count(*) filter (where created_at > now() - interval '30 days')::int as d30,
             count(*) filter (where is_admin)::int as admins,
             count(*) filter (where suspended_at is not null)::int as suspended
      from users`,
    sql<{ total: number; orders: number; customers: number; syncing: number }[]>`
      select count(*)::int as total, coalesce(sum(order_count), 0)::int as orders,
             coalesce(sum(customer_count), 0)::int as customers,
             count(*) filter (where not backfill_done)::int as syncing
      from stores`,
    sql<{ plan: string | null; subscription_status: string; n: number }[]>`
      select plan, subscription_status, count(*)::int as n from profiles
      where plan is not null group by plan, subscription_status`,
    sql<{ d30: number; all_time: number; count30: number }[]>`
      select coalesce(sum(amount_paise) filter (where paid_at > now() - interval '30 days'), 0)::bigint::float8 as d30,
             coalesce(sum(amount_paise), 0)::bigint::float8 as all_time,
             count(*) filter (where paid_at > now() - interval '30 days')::int as count30
      from billing_invoices where status = 'paid'`,
    sql<{ sent: number; senders: number }[]>`
      select coalesce(sum(sent_count), 0)::int as sent, count(*)::int as senders
      from whatsapp_usage where period = ${period}`,
    sql<{ last: Date | null; d1: number }[]>`
      select max(received_at) as last, count(*) filter (where received_at > now() - interval '1 day')::int as d1
      from billing_webhook_events`,
    sql<{ day: string; n: number }[]>`
      select to_char(d, 'YYYY-MM-DD') as day, count(u.id)::int as n
      from generate_series(current_date - 29, current_date, interval '1 day') d
      left join users u on u.created_at::date = d::date
      group by d order by d`,
    sql<{ id: string; email: string; created_at: Date; plan: string | null }[]>`
      select u.id, u.email, u.created_at, p.plan from users u left join profiles p on p.id = u.id
      order by u.created_at desc limit 8`,
    getPlanCatalog(),
  ]);

  // Monthly recurring revenue: live subscriptions × the tier's catalog price.
  const live = subs.filter((s) => s.subscription_status === "active" || s.subscription_status === "past_due");
  const mrrPaise = live.reduce((sum, s) => sum + (catalog.find((p) => p.id === s.plan)?.pricePaise ?? 0) * s.n, 0);
  const byPlan = catalog.map((p) => ({
    id: p.id,
    name: p.name,
    active: subs.filter((s) => s.plan === p.id && s.subscription_status === "active").reduce((a, s) => a + s.n, 0),
    trial: subs.filter((s) => s.plan === p.id && s.subscription_status === "authenticated").reduce((a, s) => a + s.n, 0),
    pastDue: subs.filter((s) => s.plan === p.id && s.subscription_status === "past_due").reduce((a, s) => a + s.n, 0),
  }));

  const whatsapp = sessionsSummary();

  return NextResponse.json({
    users,
    stores,
    billing: {
      mrrPaise,
      revenue30Paise: revenue.d30,
      revenueAllPaise: revenue.all_time,
      payments30: revenue.count30,
      byPlan,
    },
    messages: { period, ...messages },
    webhooks: { lastReceivedAt: webhooks.last?.toISOString() ?? null, last24h: webhooks.d1 },
    whatsapp,
    signups,
    recent: recent.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
  });
}

/** Linked WhatsApp numbers in this process, read from the engine registry without loading the engine. */
function sessionsSummary() {
  const reg = (globalThis as { __growthWhatsApp?: { sessions: Map<string, { status: string }> } }).__growthWhatsApp;
  const all = reg ? [...reg.sessions.values()] : [];
  return {
    linked: all.filter((s) => s.status !== "created").length,
    connected: all.filter((s) => s.status === "ready").length,
  };
}

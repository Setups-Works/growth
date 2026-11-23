import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { billingEnforced } from "@/lib/billing/usage";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The events src/app/api/billing/webhook/route.ts acts on — what to tick in Razorpay. */
const WEBHOOK_EVENTS = [
  "subscription.authenticated",
  "subscription.activated",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
];

/** Admin: subscriptions, payments and the Razorpay webhook's health. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const sql = db();

  const [subscriptions, invoices, events, [byType]] = await Promise.all([
    sql`
      select p.id, p.email, p.plan, p.subscription_status, p.razorpay_subscription_id, p.current_period_end,
             p.trial_ends_at, p.grace_until, p.comp_until, p.legacy_unlimited
      from profiles p
      where p.plan is not null or p.legacy_unlimited or p.razorpay_subscription_id is not null
      order by p.updated_at desc limit 200`,
    sql`
      select i.id, i.user_id, p.email, i.plan, i.amount_paise, i.currency, i.status, i.paid_at, i.razorpay_payment_id
      from billing_invoices i left join profiles p on p.id = i.user_id
      order by i.paid_at desc limit 100`,
    sql`select event_type, received_at from billing_webhook_events order by received_at desc limit 25`,
    sql<{ total: number; last: Date | null }[]>`select count(*)::int as total, max(received_at) as last from billing_webhook_events`,
  ]);

  const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  return NextResponse.json({
    billingEnabled: billingEnforced(),
    keyMode: process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") ? "live" : process.env.RAZORPAY_KEY_ID ? "test" : null,
    webhook: {
      url: `${base}/api/billing/webhook`,
      secretSet: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
      events: WEBHOOK_EVENTS,
      received: byType.total,
      lastReceivedAt: byType.last?.toISOString() ?? null,
      recent: events,
    },
    subscriptions,
    invoices,
  });
}

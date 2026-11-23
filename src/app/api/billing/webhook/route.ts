import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { GROWTH_APP_TAG, hashWebhookBody, tagOf, verifyWebhookSignature } from "@/lib/billing/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-to-server webhook from Razorpay carrying subscription/payment state.
 *
 * Modelled on src/app/api/auth/woo/callback/route.ts — the one other route in
 * this codebase that has to trust an unauthenticated POST from a third party:
 * parse, verify, one persistence step, done. The verification here is a real
 * HMAC signature (Razorpay signs every webhook), unlike Woo's opaque token,
 * so it is checked before anything else runs.
 *
 * The body must be read as raw text, not JSON, because the signature is over
 * the exact bytes Razorpay sent — re-serializing parsed JSON can change
 * whitespace and silently break verification.
 */
export async function POST(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "RAZORPAY_WEBHOOK_SECRET is not set." }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!signature || !verifyWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let event: {
    event: string;
    payload: {
      subscription?: { entity: { id: string; status: string; plan_id: string; current_end: number; notes?: unknown } };
      payment?: { entity: { id: string; amount: number; currency: string } };
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  /*
   * This Razorpay account is shared with other websites, and Razorpay sends
   * every event on the account to every webhook endpoint. Only subscription
   * events concern this app, and only for subscriptions it created: tagged
   * notes.app = "growth" (everything since tagging began), or already held
   * by a profile here (older, untagged ones). Anything else belongs to
   * another site and is acknowledged with a 200 and otherwise ignored —
   * not stored, and never an error, since Razorpay disables an endpoint that
   * keeps failing.
   */
  const subEntity = event.payload.subscription?.entity;
  if (!subEntity) return NextResponse.json({ ok: true, ignored: "not a subscription event" });
  const tag = tagOf(subEntity.notes);
  if (tag && tag !== GROWTH_APP_TAG) return NextResponse.json({ ok: true, ignored: "another site" });
  if (!tag) {
    const known = await db()`select 1 from profiles where razorpay_subscription_id = ${subEntity.id}`;
    if (known.length === 0) return NextResponse.json({ ok: true, ignored: "unknown subscription" });
  }

  // Razorpay delivers at-least-once; a retried delivery is byte-identical, so
  // the raw body's hash — not any field inside the payload — is the dedupe
  // key. Already-seen deliveries are acknowledged, never reprocessed.
  const hash = hashWebhookBody(rawBody);
  const dup = await db()`select 1 from billing_webhook_events where body_hash = ${hash}`;
  if (dup.length > 0) return NextResponse.json({ ok: true, duplicate: true });
  await db()`insert into billing_webhook_events (body_hash, event_type) values (${hash}, ${event.event})`;

  const subscriptionId = event.payload.subscription?.entity.id;

  switch (event.event) {
    case "subscription.authenticated": {
      // Fires once the UPI or card mandate is actually set up — for a trial
      // subscription (start_at in the future) this is the moment the trial
      // genuinely begins, well before the first charge; for an immediate
      // subscription it's a brief intermediate state on the way to
      // subscription.activated moments later. Safe to run for both: only a
      // profile whose *current* checkout attempt requested a trial
      // (trial_ends_at is set) has trial_used_at burned, and only once —
      // idempotent under this route's own billing_webhook_events dedupe.
      const sub = event.payload.subscription?.entity;
      if (!sub) break;
      await db()`
        update profiles
           set subscription_status = 'authenticated',
               trial_used_at = case when trial_ends_at is not null then now() else trial_used_at end
         where razorpay_subscription_id = ${sub.id}
      `;
      break;
    }

    case "subscription.activated": {
      const sub = event.payload.subscription?.entity;
      if (!sub) break;
      await db()`
        update profiles
           set subscription_status = 'active',
               current_period_end = to_timestamp(${sub.current_end}),
               grace_until = null
         where razorpay_subscription_id = ${sub.id}
      `;
      break;
    }

    case "subscription.charged": {
      const sub = event.payload.subscription?.entity;
      const payment = event.payload.payment?.entity;
      if (!sub || !payment) break;

      const [profile] = await db()<{ id: string; plan: "go" | "plus" | "lite" | null }[]>`
        select id, plan from profiles where razorpay_subscription_id = ${sub.id}
      `;
      if (!profile?.plan) break;

      const periodEnd = new Date(sub.current_end * 1000);
      const periodStart = new Date(periodEnd);
      periodStart.setUTCMonth(periodStart.getUTCMonth() - 1);

      // No further dedupe needed here: the billing_webhook_events check above
      // already guarantees this exact delivery is only ever processed once.
      await db()`
        insert into billing_invoices
          (user_id, razorpay_payment_id, plan, amount_paise, currency, status, period_start, period_end, paid_at)
        values
          (${profile.id}, ${payment.id}, ${profile.plan}, ${payment.amount}, ${payment.currency},
           'paid', ${periodStart.toISOString()}, ${periodEnd.toISOString()}, now())
      `;
      // A new calendar month simply gets a fresh whatsapp_usage row the next
      // time a send is recorded — nothing to reset here.
      await db()`
        update profiles
           set subscription_status = 'active', current_period_end = to_timestamp(${sub.current_end}), grace_until = null
         where id = ${profile.id}
      `;
      break;
    }

    // subscription.pending is Razorpay's "a charge failed, retrying" for a
    // subscription; payment.failed rarely carries the subscription at all.
    case "subscription.pending":
    case "payment.failed": {
      if (!subscriptionId) break;
      // 3-day grace: UPI and card debits bounce transiently (balance timing) and
      // Razorpay itself retries — cutting someone off on the first bounce of
      // a mandate they already approved would be needlessly aggressive.
      await db()`
        update profiles
           set subscription_status = 'past_due', grace_until = now() + interval '3 days'
         where razorpay_subscription_id = ${subscriptionId}
      `;
      break;
    }

    case "subscription.halted":
      if (subscriptionId) {
        await db()`
          update profiles set subscription_status = 'halted', grace_until = null
          where razorpay_subscription_id = ${subscriptionId}
        `;
      }
      break;

    case "subscription.cancelled":
      if (subscriptionId) {
        await db()`
          update profiles set subscription_status = 'cancelled', grace_until = null
          where razorpay_subscription_id = ${subscriptionId}
        `;
      }
      break;

    default:
      // Unhandled event types are acknowledged, not errors — Razorpay sends
      // many more than this app acts on.
      break;
  }

  return NextResponse.json({ ok: true });
}

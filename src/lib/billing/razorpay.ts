import { createHash } from "node:crypto";
import Razorpay from "razorpay";

/**
 * Razorpay subscriptions and customers, via the official SDK.
 *
 * A thin wrapper rather than calling `client.subscriptions.create(...)`
 * everywhere it's needed — this is the one place that knows the plan-id env
 * vars and the "12 cycles, autopay" shape, so every caller asks for a plan by
 * name instead of repeating Razorpay's request shape.
 */

let client: Razorpay | null = null;

/**
 * The tag on every plan and subscription this app creates (`notes.app`).
 *
 * One Razorpay account is shared with other websites, and Razorpay sends
 * every webhook endpoint every event on the account. The tag is how the
 * webhook and the admin panel tell Growth's subscriptions and plans from
 * the other sites' ones.
 */
export const GROWTH_APP_TAG = "growth";

function razorpay(): Razorpay {
  if (client) return client;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set, so billing is unavailable.");
  }
  client = new Razorpay({ key_id, key_secret });
  return client;
}

export interface RazorpayCustomer {
  id: string;
}

export async function createCustomer(email: string, name?: string, contact?: string): Promise<RazorpayCustomer> {
  const customer = await razorpay().customers.create({
    email,
    name: name || email,
    ...(contact ? { contact } : {}),
    /*
     * Returns the existing customer instead of erroring. It must be the
     * string "0": the SDK's type allows the number 0, but Razorpay ignores
     * a numeric value and answers "Customer already exists for the
     * merchant", which broke checkout for anyone who had tried it before.
     */
    fail_existing: "0" as unknown as 0,
  });
  return { id: customer.id };
}

/**
 * Brings an existing Razorpay customer's name and phone in line with the
 * account's sign-up details. Best effort: a failure here never blocks checkout.
 */
export async function syncCustomer(
  customerId: string,
  details: { name?: string; contact?: string; email?: string },
): Promise<void> {
  if (!details.name && !details.contact && !details.email) return;
  try {
    await razorpay().customers.edit(customerId, {
      ...(details.name ? { name: details.name } : {}),
      ...(details.email ? { email: details.email } : {}),
      ...(details.contact ? { contact: details.contact } : {}),
    });
  } catch (error) {
    console.warn("[billing] couldn't update the Razorpay customer", (error as { error?: { description?: string } })?.error?.description ?? error);
  }
}

export interface RazorpaySubscription {
  id: string;
  status: string;
  short_url: string;
  current_end: number | null;
}

export async function createSubscription(opts: {
  customerId: string;
  planId: string;
  /**
   * Unix seconds. Omit for immediate billing. When set, the UPI or card mandate is
   * still authorized right away via Checkout.js -- only the first charge is
   * deferred to this moment, which is what a free trial actually is on
   * Razorpay: a real, live mandate from day one, not a promise to ask for
   * one later. See src/app/api/billing/checkout/route.ts for how this is
   * computed (now + 14 days) and gated to one trial per account, ever.
   */
  startAt?: number;
  /** Stored on the subscription in Razorpay, so it's clear which site it belongs to. */
  notes?: Record<string, string>;
}): Promise<RazorpaySubscription> {
  /*
   * The Subscriptions Create API has no "method" field — which payment
   * method a customer sees is a Checkout.js concern, not a subscription-
   * creation one. Checkout.js (see BillingCard) offers every recurring
   * method the account has enabled — UPI Autopay and cards — not what's requested
   * here.
   */
  // customer_id is a real, documented field on this endpoint that the SDK's
  // own types omit — cast narrowly rather than widening the whole call.
  const body = {
    plan_id: opts.planId,
    customer_id: opts.customerId,
    // Counts 12 cycles from start_at, not from creation -- with a trial this
    // still lands as 12 monthly charges beginning once the trial ends.
    total_count: 12,
    // The mandate is completed right here, inline, via Checkout.js (see
    // BillingCard) -- Razorpay's own notify-by-email flow is a parallel,
    // confusing path to the same short_url a customer never needs to see.
    customer_notify: 0,
    ...(opts.startAt ? { start_at: opts.startAt } : {}),
    // One Razorpay account can serve several websites; this marks ours.
    notes: { app: GROWTH_APP_TAG, ...(opts.notes ?? {}) },
  } as unknown as Parameters<Razorpay["subscriptions"]["create"]>[0];

  const subscription = await razorpay().subscriptions.create(body);

  return {
    id: subscription.id,
    status: subscription.status,
    short_url: subscription.short_url,
    current_end: subscription.current_end ?? null,
  };
}

export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await razorpay().subscriptions.cancel(subscriptionId, false);
}

/**
 * Verifies a webhook actually came from Razorpay, using the SDK's own
 * constant-time HMAC check rather than a hand-rolled one.
 *
 * Must be called with the *raw* request body — the signature is over the
 * exact bytes Razorpay sent, and re-serializing parsed JSON can change
 * whitespace and silently break verification.
 */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  return Razorpay.validateWebhookSignature(rawBody, signature, secret);
}

/** Dedupe key for a webhook delivery — Razorpay retries are byte-identical. */
export function hashWebhookBody(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export interface RazorpayPlan {
  id: string;
  name: string;
  amountPaise: number;
  currency: string;
  period: string;
  interval: number;
  createdAt: number;
  /** Made by this app (notes.app = "growth"), as opposed to another site on the same account. */
  ours: boolean;
}

/** Plans on the Razorpay account, newest first — for the admin panel. */
export async function listPlans(): Promise<RazorpayPlan[]> {
  const res = await razorpay().plans.all({ count: 100 });
  return res.items.map((p) => ({
    id: p.id,
    name: p.item.name,
    amountPaise: Number(p.item.amount),
    currency: p.item.currency,
    period: p.period,
    interval: p.interval,
    createdAt: p.created_at,
    ours: tagOf(p.notes) === GROWTH_APP_TAG,
  }));
}

/**
 * Creates a monthly plan. Razorpay plans can't be edited or deleted, so a new
 * price is always a new plan; existing subscriptions stay on their old one.
 */
export async function createPlan(opts: { name: string; amountPaise: number; description?: string; tier: string }): Promise<RazorpayPlan> {
  const p = await razorpay().plans.create({
    period: "monthly",
    interval: 1,
    item: { name: opts.name, amount: opts.amountPaise, currency: "INR", description: opts.description ?? "" },
    notes: { app: GROWTH_APP_TAG, tier: opts.tier },
  });
  return {
    id: p.id,
    name: p.item.name,
    amountPaise: Number(p.item.amount),
    currency: p.item.currency,
    period: p.period,
    interval: p.interval,
    createdAt: p.created_at,
    ours: true,
  };
}

/** notes.app from a Razorpay entity. Razorpay sends `[]` rather than `{}` when there are no notes. */
export function tagOf(notes: unknown): string | null {
  if (!notes || Array.isArray(notes) || typeof notes !== "object") return null;
  const app = (notes as Record<string, unknown>).app;
  return typeof app === "string" ? app : null;
}

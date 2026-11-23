import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { requireTenant } from "@/lib/auth/tenant";
import { billingEnforced, planMessageLimit, type BillingProfile } from "@/lib/billing/usage";
import { allowanceLabel, formatPrice, getPlanCatalog } from "@/lib/billing/catalog";
import { isAdminUser } from "@/lib/auth/admin";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProfileRow extends BillingProfile {
  current_period_end: Date | null;
  trial_used_at: Date | null;
}

export async function GET(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { userId } = resolved.value;

  const [profile] = await db()<ProfileRow[]>`
    select plan, subscription_status, current_period_end, grace_until, legacy_unlimited,
           trial_ends_at, trial_used_at, comp_until
    from profiles
    where id = ${userId}
  `;

  const period = new Date().toISOString().slice(0, 7);
  const [usage] = await db()<{ sent_count: number }[]>`
    select sent_count from whatsapp_usage where user_id = ${userId} and period = ${period}
  `;
  const sent = usage?.sent_count ?? 0;

  // Same policy the send gate itself uses (checkSendAllowance) -- a profile
  // with no active plan gets a 0 limit here too, not the Go figure by default.
  const [catalog, settings] = await Promise.all([getPlanCatalog(), getSettings()]);
  const limit = profile ? planMessageLimit(profile, catalog) : 0;

  return NextResponse.json({
    plan: profile?.plan ?? null,
    subscriptionStatus: profile?.subscription_status ?? "none",
    currentPeriodEnd: profile?.current_period_end?.toISOString() ?? null,
    graceUntil: profile?.grace_until?.toISOString() ?? null,
    legacyUnlimited: profile?.legacy_unlimited ?? false,
    usage: { sent, limit },
    trialEndsAt: profile?.trial_ends_at?.toISOString() ?? null,
    trialAvailable: !profile?.trial_used_at,
    compUntil: profile?.comp_until && profile.comp_until.getTime() > Date.now() ? profile.comp_until.toISOString() : null,
    /** The tiers on offer, as the admin panel has them. */
    plans: catalog.map((p) => ({
      id: p.id,
      name: p.name,
      priceLabel: `${formatPrice(p.pricePaise)}/mo`,
      detail: allowanceLabel(p),
      trialDays: p.trialDays,
      whatsapp: p.whatsapp,
    })),
    /** Razorpay's public key id, for Checkout.js — read at runtime, not baked into the bundle. */
    checkoutKey: process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? null,
    billingEnabled: billingEnforced(),
    isAdmin: await isAdminUser(userId),
    announcement: settings.announcement.enabled && settings.announcement.message ? settings.announcement : null,
    supportEmail: settings.supportEmail || null,
  });
}

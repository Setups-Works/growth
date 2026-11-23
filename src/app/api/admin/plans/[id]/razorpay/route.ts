import { NextResponse } from "next/server";
import { audit, requireAdmin } from "@/lib/auth/admin";
import { getPlan, invalidatePlanCatalog, PLAN_IDS } from "@/lib/billing/catalog";
import { createPlan } from "@/lib/billing/razorpay";
import { billingEnforced, type PlanId } from "@/lib/billing/usage";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin: create a Razorpay plan at this tier's current price and link it, so
 * new subscriptions are charged what the pricing page says. Existing
 * subscribers stay on the plan they signed up for (Razorpay plans are
 * immutable; there is no in-place price change).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!PLAN_IDS.includes(id as PlanId)) return NextResponse.json({ error: "Unknown plan." }, { status: 404 });
  if (!billingEnforced()) {
    return NextResponse.json({ error: "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET first." }, { status: 503 });
  }

  invalidatePlanCatalog();
  const tier = await getPlan(id as PlanId);
  if (tier.pricePaise < 100) {
    return NextResponse.json({ error: "Razorpay needs a price of at least ₹1." }, { status: 422 });
  }

  try {
    const created = await createPlan({
      name: `Setups Works Growth ${tier.name}`,
      amountPaise: tier.pricePaise,
      description: tier.blurb.slice(0, 200),
      tier: tier.id,
    });
    await db()`update billing_plans set razorpay_plan_id = ${created.id}, updated_at = now() where id = ${tier.id}`;
    invalidatePlanCatalog();
    await audit(gate.admin, "create_razorpay_plan", tier.id, { planId: created.id, amountPaise: created.amountPaise });
    return NextResponse.json({ ok: true, plan: created });
  } catch (e) {
    const description = (e as { error?: { description?: string } })?.error?.description;
    return NextResponse.json({ error: description ?? "Razorpay refused the plan." }, { status: 502 });
  }
}

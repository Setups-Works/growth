import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireAdmin } from "@/lib/auth/admin";
import { getPlanCatalog, invalidatePlanCatalog, razorpayPlanFor } from "@/lib/billing/catalog";
import { listPlans, type RazorpayPlan } from "@/lib/billing/razorpay";
import { billingEnforced } from "@/lib/billing/usage";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: the plan catalog, with the Razorpay plan each tier is linked to. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;

  invalidatePlanCatalog();
  const catalog = await getPlanCatalog();
  let razorpayPlans: RazorpayPlan[] = [];
  let razorpayError: string | null = null;
  if (billingEnforced()) {
    try {
      razorpayPlans = await listPlans();
    } catch (e) {
      razorpayError = (e as { error?: { description?: string } })?.error?.description ?? "Could not reach Razorpay.";
    }
  }

  const [subscribers] = await db()<{ lite: number; go: number; plus: number }[]>`
    select count(*) filter (where plan = 'lite')::int as lite,
           count(*) filter (where plan = 'go')::int as go,
           count(*) filter (where plan = 'plus')::int as plus
    from profiles where subscription_status in ('active', 'authenticated', 'past_due') or comp_until > now()`;

  return NextResponse.json({
    billingEnabled: billingEnforced(),
    razorpayError,
    plans: catalog.map((p) => {
      const linkedId = razorpayPlanFor(p) ?? null;
      const linked = razorpayPlans.find((r) => r.id === linkedId) ?? null;
      return {
        ...p,
        linkedPlanId: linkedId,
        linkedFrom: p.razorpayPlanId ? "admin" : linkedId ? "env" : null,
        linked,
        /** The price people see differs from what Razorpay will charge. */
        priceMismatch: linked ? linked.amountPaise !== p.pricePaise : false,
        subscribers: subscribers[p.id],
      };
    }),
    razorpayPlans,
  });
}

const update = z.object({
  id: z.enum(["lite", "go", "plus"]),
  name: z.string().trim().min(1).max(40),
  pricePaise: z.number().int().min(0).max(100_000_000),
  cadence: z.string().trim().min(1).max(30),
  blurb: z.string().trim().max(200),
  features: z.array(z.string().trim().min(1).max(160)).max(15),
  messageLimit: z.number().int().min(0).max(10_000_000).nullable(),
  whatsapp: z.boolean(),
  highlight: z.boolean(),
  trialDays: z.number().int().min(0).max(90),
  razorpayPlanId: z
    .string()
    .trim()
    .regex(/^plan_[A-Za-z0-9]+$/, "A Razorpay plan id looks like plan_XXXXXXXX.")
    .nullable(),
});

/** Admin: save one tier. Takes effect on the pricing pages, billing and the send gate within seconds. */
export async function PUT(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const parsed = update.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid plan." }, { status: 422 });
  }
  const p = parsed.data;
  // Lite-style tiers without WhatsApp have no allowance to speak of.
  const messageLimit = p.whatsapp ? p.messageLimit : 0;

  await db()`
    insert into billing_plans (id, name, price_paise, cadence, blurb, features, message_limit, whatsapp, highlight,
                               trial_days, razorpay_plan_id, updated_at)
    values (${p.id}, ${p.name}, ${p.pricePaise}, ${p.cadence}, ${p.blurb}, ${db().json(p.features)}, ${messageLimit},
            ${p.whatsapp}, ${p.highlight}, ${p.trialDays}, ${p.razorpayPlanId}, now())
    on conflict (id) do update set
      name = excluded.name, price_paise = excluded.price_paise, cadence = excluded.cadence, blurb = excluded.blurb,
      features = excluded.features, message_limit = excluded.message_limit, whatsapp = excluded.whatsapp,
      highlight = excluded.highlight, trial_days = excluded.trial_days, razorpay_plan_id = excluded.razorpay_plan_id,
      updated_at = now()`;
  // One recommended tier at a time.
  if (p.highlight) await db()`update billing_plans set highlight = false where id <> ${p.id}`;
  invalidatePlanCatalog();
  await audit(gate.admin, "update_plan", p.id, { ...p, messageLimit });
  return NextResponse.json({ ok: true });
}

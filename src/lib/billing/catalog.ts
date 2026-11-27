import { db, databaseConfigured } from "@/lib/db/client";
import type { PlanId } from "@/lib/billing/usage";

/**
 * The plan catalog: what each tier is called, costs, includes and is capped
 * at — edited in the admin panel, stored in `billing_plans`.
 *
 * Everything that shows or enforces a plan reads it from here: the pricing
 * pages, Settings → Billing, checkout (which Razorpay plan to subscribe to,
 * how long the trial is) and the send gate (the monthly cap). One source, so
 * the price on the landing page and the price charged cannot disagree.
 *
 * Cached in memory for a short time — the send gate asks on every message —
 * and cleared the moment the admin panel saves a change in this process.
 * When the database is unreachable (a build, a broken connection) the
 * defaults below are served rather than failing the page.
 */

export interface CatalogPlan {
  id: PlanId;
  name: string;
  pricePaise: number;
  cadence: string;
  blurb: string;
  features: string[];
  /** null = unlimited WhatsApp messages a month; 0 = none. */
  messageLimit: number | null;
  whatsapp: boolean;
  highlight: boolean;
  trialDays: number;
  /** Explicit Razorpay plan, or null to fall back to RAZORPAY_PLAN_ID_<TIER>. */
  razorpayPlanId: string | null;
  sort: number;
}

export const PLAN_IDS: PlanId[] = ["lite", "go", "plus"];

export const DEFAULT_CATALOG: CatalogPlan[] = [
  {
    id: "lite",
    name: "Lite",
    pricePaise: 199900,
    cadence: "per month",
    blurb: "For a store that wants the analytics, not the messaging.",
    features: [
      "Every analytics module — RFM, cohorts, LTV, products, inventory",
      "Report exports (PDF, Excel, CSV)",
      "No WhatsApp campaigns, flows, auto-reply, order confirmations or assistant",
      "Pay by UPI Autopay or card, cancel anytime",
    ],
    messageLimit: 0,
    whatsapp: false,
    highlight: false,
    trialDays: 14,
    razorpayPlanId: null,
    sort: 1,
  },
  {
    id: "go",
    name: "Go",
    pricePaise: 399900,
    cadence: "per month",
    blurb: "For a store sending campaigns and flows at a steady pace.",
    features: [
      "10,000 WhatsApp messages per month",
      "Every feature included — analytics, campaigns, flows, the assistant",
      "Pay by UPI Autopay or card, cancel anytime",
    ],
    messageLimit: 10_000,
    whatsapp: true,
    highlight: false,
    trialDays: 14,
    razorpayPlanId: null,
    sort: 2,
  },
  {
    id: "plus",
    name: "Plus",
    pricePaise: 599900,
    cadence: "per month",
    blurb: "For a store that doesn't want to think about a message count.",
    features: [
      "Unlimited WhatsApp messages",
      "Every feature included — analytics, campaigns, flows, the assistant",
      "Pay by UPI Autopay or card, cancel anytime",
    ],
    messageLimit: null,
    whatsapp: true,
    highlight: true,
    trialDays: 14,
    razorpayPlanId: null,
    sort: 3,
  },
];

const TTL_MS = 30_000;
const g = globalThis as typeof globalThis & { __growthCatalog?: { at: number; plans: CatalogPlan[] } };

interface Row {
  id: PlanId;
  name: string;
  price_paise: number;
  cadence: string;
  blurb: string;
  features: string[];
  message_limit: number | null;
  whatsapp: boolean;
  highlight: boolean;
  trial_days: number;
  razorpay_plan_id: string | null;
  sort: number;
}

export async function getPlanCatalog(): Promise<CatalogPlan[]> {
  const cached = g.__growthCatalog;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.plans;
  if (!databaseConfigured()) return DEFAULT_CATALOG;
  try {
    const rows = await db()<Row[]>`select * from billing_plans order by sort, id`;
    const plans = PLAN_IDS.map((id) => {
      const r = rows.find((x) => x.id === id);
      const fallback = DEFAULT_CATALOG.find((p) => p.id === id)!;
      if (!r) return fallback;
      return {
        id,
        name: r.name,
        pricePaise: r.price_paise,
        cadence: r.cadence,
        blurb: r.blurb,
        features: Array.isArray(r.features) ? r.features : [],
        messageLimit: r.message_limit,
        whatsapp: r.whatsapp,
        highlight: r.highlight,
        trialDays: r.trial_days,
        razorpayPlanId: r.razorpay_plan_id,
        sort: r.sort,
      };
    }).sort((a, b) => a.sort - b.sort);
    g.__growthCatalog = { at: Date.now(), plans };
    return plans;
  } catch {
    return DEFAULT_CATALOG;
  }
}

export async function getPlan(id: PlanId): Promise<CatalogPlan> {
  const plans = await getPlanCatalog();
  return plans.find((p) => p.id === id) ?? DEFAULT_CATALOG.find((p) => p.id === id)!;
}

/** Forget the cached catalog, after the admin panel changes it. */
export function invalidatePlanCatalog(): void {
  g.__growthCatalog = undefined;
}

/** The Razorpay plan a new subscription to this tier goes on. */
export function razorpayPlanFor(plan: CatalogPlan): string | undefined {
  const fromEnv: Record<PlanId, string | undefined> = {
    go: process.env.RAZORPAY_PLAN_ID_GO,
    plus: process.env.RAZORPAY_PLAN_ID_PLUS,
    lite: process.env.RAZORPAY_PLAN_ID_LITE,
  };
  return plan.razorpayPlanId || fromEnv[plan.id] || undefined;
}

/** "₹3,999" — whole rupees when the price is whole, paise otherwise. */
export function formatPrice(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
  }).format(rupees);
}

/** One line describing the plan's WhatsApp allowance. */
export function allowanceLabel(plan: Pick<CatalogPlan, "whatsapp" | "messageLimit">): string {
  if (!plan.whatsapp || plan.messageLimit === 0) return "Analytics only — no WhatsApp";
  if (plan.messageLimit === null) return "Unlimited WhatsApp messages";
  return `${plan.messageLimit.toLocaleString("en-IN")} WhatsApp messages/month`;
}

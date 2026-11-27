import type { PlanId } from "@/lib/billing/usage";
import { DEFAULT_CATALOG, formatPrice, getPlanCatalog, type CatalogPlan } from "@/lib/billing/catalog";

/**
 * Pricing, in one place.
 *
 * The landing page and /pricing both show tiers. Holding the figures here
 * means a price cannot be right on one page and stale on the other — which is
 * the specific failure that makes a visitor stop trusting the rest of the
 * numbers on the site. These are the real, billed prices — see
 * src/lib/billing/usage.ts for how the message cap and the WhatsApp gate
 * (planIncludesWhatsApp) are enforced, and
 * the `plan` check constraint in db/migrations/0001_baseline.sql for the values these
 * must stay in sync with (RAZORPAY_PLAN_ID_GO / _PLUS / _LITE).
 *
 * Go and Plus include every module — analytics, campaigns, flows, the
 * assistant, all of it — and differ only in how many WhatsApp messages a
 * month can go out, because that is the one thing that costs real money to
 * carry (a gateway your customers' replies flow through). Lite is a
 * different kind of tier, not a smaller Go: analytics only, no WhatsApp
 * surface at all — see ANALYTICS_MODULES / WHATSAPP_MODULES below for the
 * split, and src/proxy.ts's WHATSAPP_PAGES / WHATSAPP_API for how it's
 * actually enforced, not just advertised.
 */

export interface Plan {
  id: PlanId;
  name: string;
  price: string;
  pricePaise: number;
  cadence: string;
  blurb: string;
  highlight: boolean;
  cta: string;
  href: string;
  limits: string[];
  /** Whether this tier includes WhatsApp campaigns, flows and the auto-reply menu. */
  whatsapp: boolean;
}

/** The catalog (src/lib/billing/catalog.ts, edited in Admin → Plans) as the marketing pages show it. */
export function toMarketingPlans(catalog: CatalogPlan[]): Plan[] {
  return catalog.map((p) => ({
    id: p.id,
    name: p.name,
    price: formatPrice(p.pricePaise),
    pricePaise: p.pricePaise,
    cadence: p.cadence,
    blurb: p.blurb,
    highlight: p.highlight,
    cta: p.trialDays > 0 ? "Start free" : "Get started",
    href: "/signup",
    whatsapp: p.whatsapp,
    limits: p.features,
  }));
}

/** The defaults, for code that can't wait on the database (structured data at build time). */
export const PLANS: Plan[] = toMarketingPlans(DEFAULT_CATALOG);

/** The live catalog, for server-rendered pricing. Falls back to the defaults without a database. */
export async function getMarketingPlans(): Promise<Plan[]> {
  return toMarketingPlans(await getPlanCatalog());
}

/** In every tier, Lite included. */
export const ANALYTICS_MODULES = [
  "Revenue, orders and repeat rate",
  "RFM segmentation and value tiers",
  "Predicted lifetime value",
  "Cohort retention",
  "Acquisition channels",
  "Product performance and ABC classes",
  "Market-basket affinity",
  "Inventory cover and reorder points",
  "B2B account rollups",
  "Report exports (PDF, Excel, CSV)",
];

/*
 * Go and Plus only. The assistant is here, not in ANALYTICS_MODULES, even
 * though it can answer plain analytics questions — its value is inseparable
 * from the WhatsApp actions it proposes, and src/proxy.ts gates the whole
 * page (and /api/ai/chat) rather than trying to split "answers questions"
 * from "drafts a send" at the route level.
 */
export const WHATSAPP_MODULES = [
  "WhatsApp campaigns",
  "Automated flows",
  "Order confirmations & abandoned-checkout reminders",
  "Auto-reply menu",
  "The assistant",
];

/** Every module, across every tier. Kept for the "no catch" framing where Go/Plus are shown alone. */
export const INCLUDED = [...ANALYTICS_MODULES, ...WHATSAPP_MODULES];

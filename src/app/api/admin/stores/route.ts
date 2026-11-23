import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db/client";
import { forgetSnapshot } from "@/lib/woo/mirror";
import { syncStore } from "@/lib/woo/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: every connected WooCommerce store, with its owner and sync state. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;

  const stores = await db()`
    select s.id, s.url, s.name, s.user_id, u.email, s.is_active, s.order_count, s.customer_count, s.product_count,
           s.last_sync_at, s.synced_through, s.backfill_done, s.created_at,
           s.abandoned_checkout_enabled, s.order_confirmation_enabled
    from stores s join users u on u.id = s.user_id
    order by s.last_sync_at desc nulls last`;
  // Credentials are never part of this response.
  return NextResponse.json({ stores, syncing: [...running()] });
}

const body = z.object({ storeId: z.string().uuid(), action: z.enum(["sync", "full_resync"]) });

/**
 * Admin: start a sync for one store now, in the background. "full_resync"
 * re-imports the whole history (use after a store's data was edited in bulk).
 */
export async function POST(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "storeId and action are required." }, { status: 422 });
  const { storeId, action } = parsed.data;

  const [s] = await db()<
    { id: string; url: string; name: string | null; consumer_key: string; consumer_secret: string; history_months: number; max_pages: number }[]
  >`select id, url, name, consumer_key, consumer_secret, history_months, max_pages from stores where id = ${storeId}`;
  if (!s) return NextResponse.json({ error: "Store not found." }, { status: 404 });
  if (running().has(storeId)) return NextResponse.json({ error: "A sync is already running for this store." }, { status: 409 });

  running().add(storeId);
  void syncStore(
    s.id,
    { id: s.id, url: s.url, name: s.name ?? undefined, consumerKey: s.consumer_key, consumerSecret: s.consumer_secret, historyMonths: s.history_months, maxPages: s.max_pages },
    { full: action === "full_resync", budgetMs: 10 * 60 * 1000 },
  )
    .then(() => forgetSnapshot(s.id))
    .catch((e) => console.error(`[admin] sync of ${s.url} failed`, e))
    .finally(() => running().delete(storeId));

  await audit(gate.admin, action, storeId, { url: s.url });
  return NextResponse.json({ ok: true, started: true });
}

function running(): Set<string> {
  const g = globalThis as typeof globalThis & { __growthAdminSyncs?: Set<string> };
  return (g.__growthAdminSyncs ??= new Set());
}

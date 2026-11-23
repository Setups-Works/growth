import { attachAttribution } from "./attribution";
import { decodeEntities } from "./entities";
import { slimOrder } from "./slim";
import type { WooCustomer, WooOrder, WooProduct } from "./types";

/**
 * What a record looks like by the time it is stored in the mirror's `raw`
 * column: normalised once at ingest, so nothing downstream repeats the work.
 *
 *  - Order attribution is parsed out of `meta_data` onto `order.attribution`
 *    (the Acquisition page reads only that), and the rest of the meta dropped.
 *  - HTML entities in names are decoded, so charts, tables, PDFs and CSVs never
 *    show "&amp;".
 *  - Orders are slimmed to the fields the app reads (see slim.ts) — on a real
 *    store about 80% of the payload is tax arrays, per-line meta and image
 *    objects that nothing uses. That is storage saved on disk and bytes saved
 *    on every snapshot read.
 *
 * Columns derived for indexing (dates, totals) are computed from the original
 * record by the writers in sync.ts, before this runs, so nothing they need is
 * lost to slimming.
 */

export function orderForStorage(order: WooOrder): WooOrder {
  const copy = { ...order };
  attachAttribution([copy]);
  copy.line_items = (copy.line_items ?? []).map((li) => ({ ...li, name: decodeEntities(li.name) }));
  const billing = copy.billing ? { ...copy.billing } : undefined;
  copy.billing = billing as WooOrder["billing"];
  if (billing) {
    if (billing.first_name) billing.first_name = decodeEntities(billing.first_name);
    if (billing.last_name) billing.last_name = decodeEntities(billing.last_name);
    if (billing.company) billing.company = decodeEntities(billing.company);
    if (billing.city) billing.city = decodeEntities(billing.city);
  }
  return slimOrder(copy);
}

/**
 * What's kept of a customer: only the fields anything reads (the analytics
 * customer directory, the inbox and campaigns). WooCommerce's full record
 * also carries the shipping address, username, role, avatar and meta data;
 * none of it is used, and on a real store it was two thirds of the row.
 */
export function customerForStorage(customer: WooCustomer): WooCustomer {
  const b = customer.billing;
  const billing = b
    ? Object.fromEntries(
        Object.entries({
          first_name: b.first_name ? decodeEntities(b.first_name) : undefined,
          last_name: b.last_name ? decodeEntities(b.last_name) : undefined,
          company: b.company ? decodeEntities(b.company) : undefined,
          email: b.email || undefined,
          phone: b.phone || undefined,
          city: b.city || undefined,
          state: b.state || undefined,
          country: b.country || undefined,
        }).filter(([, v]) => v !== undefined),
      )
    : undefined;
  return {
    id: customer.id,
    date_created: customer.date_created,
    email: customer.email,
    first_name: decodeEntities(customer.first_name),
    last_name: decodeEntities(customer.last_name),
    ...(billing ? { billing } : {}),
  } as unknown as WooCustomer;
}

export function productForStorage(product: WooProduct): WooProduct {
  const copy = { ...product };
  copy.name = decodeEntities(copy.name);
  copy.categories = (copy.categories ?? []).map((c) => ({ ...c, name: decodeEntities(c.name) }));
  copy.tags = (copy.tags ?? []).map((t) => ({ ...t, name: decodeEntities(t.name) }));
  // One image, not the gallery: a WhatsApp message shows a single picture.
  copy.images = copy.images?.length ? [{ id: 0, src: copy.images[0].src, alt: "" }] : [];
  return copy;
}

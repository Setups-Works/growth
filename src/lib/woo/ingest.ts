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

export function customerForStorage(customer: WooCustomer): WooCustomer {
  const copy = { ...customer };
  copy.first_name = decodeEntities(copy.first_name);
  copy.last_name = decodeEntities(copy.last_name);
  if (copy.billing?.company) copy.billing = { ...copy.billing, company: decodeEntities(copy.billing.company) };
  return copy;
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

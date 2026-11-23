import { expect, test } from "@playwright/test";
import { customerForStorage, orderForStorage, productForStorage } from "@/lib/woo/ingest";
import type { WooCustomer, WooOrder, WooProduct } from "@/lib/woo/types";

/**
 * What the sync stores in the mirror's `raw` column.
 *
 * This normalisation once went missing when the mirror replaced the old
 * snapshot pipeline, and nothing failed loudly: the Acquisition page simply
 * had no attribution, names showed "&amp;", and every order was stored with
 * metadata nothing reads. These pin the behaviour down.
 */

const order = {
  id: 42,
  number: "42",
  status: "completed",
  currency: "INR",
  date_created: "2026-10-01T10:00:00",
  date_created_gmt: "2026-10-01T04:30:00",
  total: "1049.00",
  customer_id: 7,
  billing: {
    first_name: "Ananya &amp; Co",
    last_name: "Rao",
    city: "Bengaluru",
    country: "IN",
    email: "a@example.com",
    phone: "9800000000",
    address_1: "12 MG Road",
    postcode: "560001",
  },
  shipping: { first_name: "Ananya", address_1: "12 MG Road" },
  line_items: [
    {
      id: 1,
      name: "Kurta &amp; Dupatta",
      product_id: 9,
      quantity: 1,
      total: "999.00",
      taxes: [{ id: 1, total: "50.00" }],
      meta_data: [{ id: 3, key: "pa_size", value: "M" }],
      image: { id: 5, src: "https://example.com/a.jpg" },
    },
  ],
  meta_data: [
    { id: 1, key: "_wc_order_attribution_source_type", value: "utm" },
    { id: 2, key: "_wc_order_attribution_utm_source", value: "instagram" },
    { id: 3, key: "_razorpay_payment_id", value: "pay_123" },
  ],
} as unknown as WooOrder;

test("orders are stored with attribution parsed out and unused fields dropped", () => {
  const stored = orderForStorage(order) as unknown as Record<string, unknown>;

  expect(stored.attribution).toMatchObject({ sourceType: "utm", source: "instagram" });
  expect(stored.meta_data).toBeUndefined();
  expect(stored.shipping).toEqual({});

  const billing = stored.billing as Record<string, unknown>;
  expect(billing.first_name).toBe("Ananya & Co");
  expect(billing.phone).toBe("9800000000"); // needed for WhatsApp sends and its index
  expect(billing.address_1).toBeUndefined();

  const [item] = stored.line_items as Record<string, unknown>[];
  expect(item.name).toBe("Kurta & Dupatta");
  expect(item.taxes).toBeUndefined();
  expect(item.meta_data).toBeUndefined();
  expect(item.image).toBeUndefined();

  expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(order).length);
});

test("the original order is not mutated (indexed columns are read from it)", () => {
  const before = JSON.stringify(order);
  orderForStorage(order);
  expect(JSON.stringify(order)).toBe(before);
});

test("customer and product names are decoded, products keep one image", () => {
  const customer = customerForStorage({ id: 1, first_name: "Ben &amp; Jo", last_name: "O&#039;Neil" } as WooCustomer);
  expect(customer.first_name).toBe("Ben & Jo");
  expect(customer.last_name).toBe("O'Neil");

  const product = productForStorage({
    id: 9,
    name: "Tee &amp; Cap",
    categories: [{ id: 1, name: "Tops &amp; Tees" }],
    images: [
      { id: 1, src: "https://example.com/1.jpg", alt: "a" },
      { id: 2, src: "https://example.com/2.jpg", alt: "b" },
    ],
  } as unknown as WooProduct);
  expect(product.name).toBe("Tee & Cap");
  expect(product.categories?.[0].name).toBe("Tops & Tees");
  expect(product.images).toHaveLength(1);
});

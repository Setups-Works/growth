import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
// Static imports on purpose: on Node 22 a module loaded with `await import()`
// inside a test cannot resolve its own "@/..." imports.
import { db } from "@/lib/db/client";
import { syncStore } from "@/lib/woo/sync";

/**
 * The WooCommerce sync, end to end against a fake store and a real database.
 *
 * Checks the order of work that makes a first sync useful quickly — products,
 * then the order history, then customers — and that everything arrives.
 * Needs DATABASE_URL (CI provides one).
 */

const PRODUCTS = 150;
const ORDERS = 1050;
const CUSTOMERS = 250;

function fakeStore() {
  const hits: string[] = [];
  const now = Date.now();
  const orders = Array.from({ length: ORDERS }, (_, i) => {
    const at = new Date(now - (ORDERS - i) * 6 * 60 * 60 * 1000).toISOString().slice(0, 19);
    return {
      id: i + 1,
      number: String(i + 1),
      status: "completed",
      currency: "INR",
      date_created: at,
      date_created_gmt: at,
      total: "499.00",
      customer_id: (i % CUSTOMERS) + 1,
      billing: { first_name: "Asha", last_name: "K", email: `c${i % CUSTOMERS}@example.com`, phone: "9800000000" },
      line_items: [{ id: i + 1, name: "Tee &amp; Cap", product_id: (i % PRODUCTS) + 1, quantity: 1, total: "499.00" }],
    };
  });
  const products = Array.from({ length: PRODUCTS }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, images: [] }));
  const customers = Array.from({ length: CUSTOMERS }, (_, i) => ({ id: i + 1, email: `c${i}@example.com`, first_name: "C", last_name: String(i), date_created: "2026-01-01T00:00:00" }));

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://store");
    const endpoint = url.pathname.replace("/wp-json/wc/v3/", "");
    const perPage = Number(url.searchParams.get("per_page") ?? 10);
    const page = Number(url.searchParams.get("page") ?? 1);
    hits.push(endpoint);

    let rows: unknown[] = [];
    if (endpoint === "products") rows = products;
    else if (endpoint === "customers") rows = customers;
    else if (endpoint === "orders") {
      const after = url.searchParams.get("after");
      rows = after ? orders.filter((o) => o.date_created_gmt > after.slice(0, 19)) : orders;
    }
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    res.writeHead(200, {
      "content-type": "application/json",
      "x-wp-total": String(rows.length),
      "x-wp-totalpages": String(Math.max(1, Math.ceil(rows.length / perPage))),
    });
    res.end(JSON.stringify(slice));
  });

  return new Promise<{ url: string; hits: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, hits, close: () => server.close() });
    });
  });
}

test("a first sync fetches products, then orders, then customers — and saves all of them", async () => {
  test.skip(!process.env.DATABASE_URL, "needs a test database");
  test.setTimeout(120_000);
  const store = await fakeStore();

  try {
    const [user] = await db()<{ id: string }[]>`
      insert into users (email, password_hash) values (${`sync-${Date.now()}@example.com`}, 'x') returning id
    `;
    const [row] = await db()<{ id: string }[]>`
      insert into stores (user_id, url, consumer_key, consumer_secret)
      values (${user.id}, ${store.url}, 'ck_test', 'cs_test') returning id
    `;
    const config = {
      id: row.id,
      url: store.url,
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      historyMonths: 24,
      maxPages: 300,
    };

    let result = await syncStore(row.id, config);
    for (let i = 0; i < 5 && !result.done; i++) result = await syncStore(row.id, config);
    expect(result.done).toBe(true);

    const [counts] = await db()<{ o: number; c: number; p: number; complete: boolean }[]>`
      select (select count(*) from woo_orders where store_id = ${row.id})::int as o,
             (select count(*) from woo_customers where store_id = ${row.id})::int as c,
             (select count(*) from woo_products where store_id = ${row.id})::int as p,
             (select customers_complete from stores where id = ${row.id}) as complete
    `;
    expect(counts).toEqual({ o: ORDERS, c: CUSTOMERS, p: PRODUCTS, complete: true });

    // Products first, customers only after the last order page.
    expect(store.hits[0]).toBe("products");
    expect(store.hits.lastIndexOf("orders")).toBeLessThan(store.hits.indexOf("customers"));

    // Names are decoded on the way in.
    const [item] = await db()<{ name: string }[]>`select name from woo_order_items where store_id = ${row.id} limit 1`;
    expect(item.name).toBe("Tee & Cap");

    // Re-importing identical data rewrites nothing: each row keeps its
    // version (xmin), so no dead copies pile up and the tables stay small.
    const versions = async () =>
      db()<{ t: string; v: string }[]>`
        select 'o' || id as t, xmin::text as v from woo_orders where store_id = ${row.id}
        union all select 'c' || id, xmin::text from woo_customers where store_id = ${row.id}
        union all select 'i' || order_id || '-' || id, xmin::text from woo_order_items where store_id = ${row.id}
        order by 1`;
    const before = await versions();
    let again = await syncStore(row.id, config, { full: true });
    for (let i = 0; i < 5 && !again.done; i++) again = await syncStore(row.id, config);
    expect(again.done).toBe(true);
    expect(await versions()).toEqual(before);

    // Customers keep only what is read.
    const [customer] = await db()<{ raw: Record<string, unknown> }[]>`select raw from woo_customers where store_id = ${row.id} limit 1`;
    expect(Object.keys(customer.raw).sort()).toEqual(["date_created", "email", "first_name", "id", "last_name"]);
  } finally {
    store.close();
  }
});

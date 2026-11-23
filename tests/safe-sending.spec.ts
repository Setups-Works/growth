import { expect, test } from "@playwright/test";
// Static imports on purpose: on Node 22 a module loaded with `await import()`
// inside a test cannot resolve its own "@/..." imports.
import { db } from "@/lib/db/client";
import { WhatsAppApiError } from "@/lib/whatsapp/engine/errors";
import { optOutIntent, SendGuard, spin, warmupLimit } from "@/lib/whatsapp/engine/guard";

/**
 * The rules behind safe sending (src/lib/whatsapp/engine/guard.ts). These
 * decide how many marketing messages a number may send and how customers
 * unsubscribe — worth pinning down, because getting them wrong costs a
 * merchant their WhatsApp number.
 */

test("a newly linked number warms up before reaching its own limit", () => {
  expect(warmupLimit(0)).toBe(30);
  expect(warmupLimit(2)).toBe(30);
  expect(warmupLimit(3)).toBe(80);
  expect(warmupLimit(7)).toBe(150);
  expect(warmupLimit(14)).toBe(300);
  expect(warmupLimit(30)).toBe(Number.POSITIVE_INFINITY);
});

test("{a|b|c} variations pick one option, and template variables are left alone", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(spin("{Hi|Hello|Hey} {{name}}"));
  expect(seen).toEqual(new Set(["Hi {{name}}", "Hello {{name}}", "Hey {{name}}"]));
  expect(spin("No variations {here}")).toBe("No variations {here}");
});

test("STOP and START replies are recognised, ordinary messages are not", () => {
  for (const t of ["STOP", "stop", " Stop. ", "unsubscribe", "Opt out"]) expect(optOutIntent(t)).toBe("stop");
  for (const t of ["START", "subscribe"]) expect(optOutIntent(t)).toBe("start");
  for (const t of ["hi", "please stop sending me the wrong size", "1"]) expect(optOutIntent(t)).toBeNull();
});

test("replies jump ahead of queued messages, and sends never overlap", async () => {
  test.setTimeout(30_000);
  const guard = new SendGuard("test-session");
  const order: string[] = [];
  let running = 0;
  let overlapped = false;
  const job = (name: string) => async () => {
    if (++running > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 50));
    order.push(name);
    running--;
    return name;
  };

  // Queued together: the first transactional message starts at once; the
  // reply then goes before the second transactional message.
  const sends = [
    guard.run("transactional", job("order-confirmation-1")),
    guard.run("transactional", job("order-confirmation-2")),
    guard.run("reply", job("inbox-reply")),
  ];
  const started = Date.now();
  await Promise.all(sends);

  expect(order).toEqual(["order-confirmation-1", "inbox-reply", "order-confirmation-2"]);
  expect(overlapped).toBe(false);
  // Human-like gaps: at least ~1s before the reply and ~3s before the next confirmation.
  expect(Date.now() - started).toBeGreaterThan(4000);
});

test("at the daily limit, marketing is refused but order confirmations still go out", async () => {
  test.skip(!process.env.DATABASE_URL, "needs a test database");

  // A number linked 40 days ago (warm-up over), limit 10/day, already at 10.
  const [user] = await db()<{ id: string }[]>`
    insert into users (email, password_hash) values (${`guard-${Date.now()}@example.com`}, 'x') returning id
  `;
  await db()`
    insert into whatsapp_connections (user_id, session_id, daily_limit, quiet_start, quiet_end, linked_at)
    values (${user.id}, ${user.id}, 10, null, null, now() - interval '40 days')
  `;
  for (let i = 0; i < 10; i++) {
    await db()`
      insert into wa_messages (session_id, wa_message_id, chat_id, from_me, type, body, "timestamp", kind)
      values (${user.id}, ${`m${i}`}, '911@c.us', true, 'text', 'x', ${Math.floor(Date.now() / 1000)}, 'marketing')
    `;
  }

  const guard = new SendGuard(user.id);
  const capacity = await guard.capacity();
  expect(capacity.sentToday).toBe(10);
  expect(capacity.remaining).toBe(0);

  const marketing = guard.run("marketing", async () => "sent");
  await expect(marketing).rejects.toBeInstanceOf(WhatsAppApiError);
  await expect(marketing).rejects.toMatchObject({ status: 429 });

  await expect(guard.run("transactional", async () => "sent")).resolves.toBe("sent");
});

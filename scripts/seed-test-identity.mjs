#!/usr/bin/env node
/**
 * Seeds one test account and API key, so the end-to-end suite can call the
 * API as a real tenant with no store connected (see playwright.config.ts).
 *
 * Only for a throwaway test database — CI runs it against a PostgreSQL
 * service container. Idempotent: re-running reuses the account and key.
 *
 *   DATABASE_URL=... TEST_API_KEY=sw_live_<random> node scripts/seed-test-identity.mjs
 */
import { createHash } from "node:crypto";
import postgres from "postgres";

const { DATABASE_URL, TEST_API_KEY } = process.env;
if (!DATABASE_URL || !TEST_API_KEY) {
  console.error("DATABASE_URL and TEST_API_KEY must be set.");
  process.exit(1);
}
if (!TEST_API_KEY.startsWith("sw_live_")) {
  console.error('TEST_API_KEY must start with "sw_live_".');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
const hash = createHash("sha256").update(TEST_API_KEY).digest("hex");

try {
  const [user] = await sql`
    insert into users (email, password_hash)
    values ('ci-test@growth.internal', 'disabled')
    on conflict ((lower(email))) do update set updated_at = now()
    returning id
  `;
  // On a WhatsApp-including plan, so the suite reaches the WhatsApp routes'
  // own validation instead of stopping at the plan gate in src/proxy.ts.
  await sql`update profiles set plan = 'plus' where id = ${user.id}`;
  await sql`
    insert into api_keys (user_id, name, hash, display, scopes)
    values (${user.id}, 'CI test key', ${hash}, 'sw_live_ci…test', ${["read", "write"]})
    on conflict (hash) do nothing
  `;
  console.log(`Seeded test identity ${user.id}.`);
} finally {
  await sql.end();
}

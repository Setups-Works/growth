#!/usr/bin/env node
/**
 * Applies db/migrations/*.sql in filename order, each once, each in its own
 * transaction. Runs automatically when the Docker container starts, and by
 * hand with `npm run db:migrate`.
 *
 * Applied files are recorded in `schema_migrations`. A Postgres advisory lock
 * makes it safe for two containers to start at the same time: the second
 * waits, then finds nothing left to do.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is not set.");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const sql = postgres(url, { max: 1, onnotice: () => {} });

// Arbitrary constant; identifies "the migration lock" for this app.
const LOCK_ID = 727274;

try {
  await sql`select pg_advisory_lock(${LOCK_ID})`;
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(join(dir, file), "utf8");
    process.stdout.write(`migrate: applying ${file} … `);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    console.log("done");
    count++;
  }

  console.log(count ? `migrate: ${count} migration(s) applied.` : "migrate: database is up to date.");
} catch (error) {
  console.error("\nmigrate: failed —", error.message);
  process.exitCode = 1;
} finally {
  await sql`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
  await sql.end();
}

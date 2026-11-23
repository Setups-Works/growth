import postgres, { type Sql } from "postgres";

/**
 * The connection to PostgreSQL — the only way the server reaches stored data.
 *
 * Configured by DATABASE_URL. In the Docker setup that points at the `db`
 * service in docker-compose.yml; on Azure it can equally point at Azure
 * Database for PostgreSQL (add `?sslmode=require`).
 *
 * The app runs as one long-lived Node process, so this is an ordinary small
 * pool. Set DATABASE_PREPARE=false when connecting through a transaction-mode
 * pooler such as PgBouncer, which cannot keep prepared statements.
 */

let client: Sql | null = null;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set, so there is nowhere to read or write. " +
        "Set it to a PostgreSQL connection string, e.g. postgres://user:pass@db:5432/growth.",
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

function connectionString(): string | null {
  return process.env.DATABASE_URL || null;
}

/** True when this deployment can reach a database at all. */
export function databaseConfigured(): boolean {
  return Boolean(connectionString());
}

export function db(): Sql {
  if (client) return client;

  const url = connectionString();
  if (!url) throw new DatabaseNotConfiguredError();

  client = postgres(url, {
    prepare: process.env.DATABASE_PREPARE !== "false",
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idle_timeout: 300,
    connect_timeout: 10,
    /*
     * SSL follows the connection string (`?sslmode=require`), so the local
     * Docker database works over the private network without certificates
     * and a managed cloud database still gets TLS.
     */
    // Postgres returns numeric as a string to avoid float precision loss.
    // These are money; parse them explicitly at the boundary rather than
    // letting a string reach arithmetic somewhere downstream.
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (value: number | string) => String(value),
        parse: (value: string) => Number(value),
      },
    },
    onnotice: () => {},
  });

  return client;
}

/**
 * Whether the database is reachable right now, as opposed to merely
 * configured. Used by the health check and by the setup screens, which should
 * say "cannot connect" rather than failing on the first real query.
 */
export async function databaseReachable(): Promise<{ ok: boolean; error?: string }> {
  if (!databaseConfigured()) return { ok: false, error: new DatabaseNotConfiguredError().message };
  try {
    await db()`select 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

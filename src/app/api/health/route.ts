import { databaseReachable } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness and database reachability, for Docker's HEALTHCHECK and any load
 * balancer probe (Azure App Service, Container Apps). Public, and reveals
 * nothing beyond "up" and "can reach the database".
 */
export async function GET() {
  const db = await databaseReachable();
  return Response.json({ ok: db.ok, database: db.ok ? "up" : "down" }, { status: db.ok ? 200 : 503 });
}

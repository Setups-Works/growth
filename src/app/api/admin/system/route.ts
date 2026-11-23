import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin: the server itself — which integrations are configured, database
 * size, migrations, process health, linked WhatsApp numbers and the admin
 * audit log. Reports only whether a secret is set, never its value.
 */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const sql = db();

  const [[size], tables, migrations, auditLog, [pg]] = await Promise.all([
    sql<{ bytes: number }[]>`select pg_database_size(current_database())::float8 as bytes`,
    sql<{ name: string; bytes: number; rows: number }[]>`
      select c.relname as name, pg_total_relation_size(c.oid)::float8 as bytes, c.reltuples::float8 as rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by pg_total_relation_size(c.oid) desc limit 12`,
    sql`select * from schema_migrations order by 1`.catch(() => []),
    sql`select id, admin_email, action, target, detail, created_at from admin_audit order by created_at desc limit 100`,
    sql<{ version: string }[]>`select version()`,
  ]);

  const set = (name: string) => Boolean(process.env[name]);
  const integrations = [
    { name: "Database", ok: true, detail: pg.version.split(",")[0] },
    { name: "Sessions (AUTH_SECRET)", ok: set("AUTH_SECRET") },
    { name: "Razorpay keys", ok: set("RAZORPAY_KEY_ID") && set("RAZORPAY_KEY_SECRET"), detail: process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") ? "live mode" : process.env.RAZORPAY_KEY_ID ? "test mode" : undefined },
    { name: "Razorpay webhook secret", ok: set("RAZORPAY_WEBHOOK_SECRET") },
    { name: "Scheduler", ok: set("CRON_SECRET") || process.env.INTERNAL_SCHEDULER === "true", detail: process.env.INTERNAL_SCHEDULER === "true" ? "in-process" : "cron container" },
    { name: "Email (SMTP)", ok: set("SMTP_HOST"), detail: set("SMTP_HOST") ? undefined : "password resets go to the server log" },
    { name: "AI assistant (GROQ_API_KEY)", ok: set("GROQ_API_KEY") },
    { name: "WhatsApp engine", ok: process.env.WHATSAPP_DISABLED !== "true", detail: process.env.WHATSAPP_DATA_DIR || ".data/whatsapp" },
    { name: "Public URL (APP_URL)", ok: set("APP_URL"), detail: process.env.APP_URL },
  ];

  const reg = (globalThis as { __growthWhatsApp?: { sessions: Map<string, { toJSON(): Record<string, unknown> }> } }).__growthWhatsApp;
  const sessions = reg ? [...reg.sessions.values()].map((s) => s.toJSON()) : [];
  const owners = sessions.length
    ? await sql<{ id: string; email: string }[]>`select id::text, email from users where id::text = any(${sessions.map((s) => String(s.id))})`
    : [];

  const mem = process.memoryUsage();
  return NextResponse.json({
    integrations,
    database: { bytes: size.bytes, tables },
    migrations,
    process: {
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    whatsapp: sessions.map((s) => ({ ...s, email: owners.find((o) => o.id === s.id)?.email ?? null })),
    audit: auditLog,
  });
}

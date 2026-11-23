import { NextResponse } from "next/server";
import { db, databaseConfigured } from "@/lib/db/client";
import { resolveTenant } from "./tenant";

/**
 * Who may use the admin panel.
 *
 * Two sources, either is enough:
 *  - ADMIN_EMAILS (comma-separated, env) — how the first admin exists before
 *    there is a panel to grant anything from, and a way back in that cannot
 *    be revoked by clicking the wrong button.
 *  - users.is_admin — granted and revoked from the panel itself.
 *
 * Admin is a browser-session-only power. An API key never reaches an admin
 * route, even its owner's: a leaked key must not be able to change another
 * account's plan or read every store on the server.
 */

export interface Admin {
  id: string;
  email: string;
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAdminUser(userId: string): Promise<boolean> {
  if (!databaseConfigured()) return false;
  try {
    const [row] = await db()<{ email: string; is_admin: boolean; suspended_at: Date | null }[]>`
      select email, is_admin, suspended_at from users where id = ${userId}
    `;
    if (!row || row.suspended_at) return false;
    return row.is_admin || adminEmails().includes(row.email.toLowerCase());
  } catch {
    return false;
  }
}

/** The calling admin, or a ready-to-return 401/403. */
export async function requireAdmin(
  request: Request,
): Promise<{ ok: true; admin: Admin } | { ok: false; response: NextResponse }> {
  const tenant = await resolveTenant(request);
  if (!tenant) {
    return { ok: false, response: NextResponse.json({ error: "Sign in first." }, { status: 401 }) };
  }
  if (tenant.via !== "session" || !(await isAdminUser(tenant.userId))) {
    return { ok: false, response: NextResponse.json({ error: "Admins only." }, { status: 403 }) };
  }
  const [row] = await db()<{ email: string }[]>`select email from users where id = ${tenant.userId}`;
  return { ok: true, admin: { id: tenant.userId, email: row?.email ?? tenant.email } };
}

/** Records an admin action. Never throws — an audit hiccup must not undo the change. */
export async function audit(
  admin: Admin,
  action: string,
  target: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db()`
      insert into admin_audit (admin_id, admin_email, action, target, detail)
      values (${admin.id}, ${admin.email}, ${action}, ${target}, ${db().json(detail as never)})
    `;
  } catch (e) {
    console.error("[admin] audit write failed", e);
  }
}

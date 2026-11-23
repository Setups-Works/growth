import { NextResponse } from "next/server";
import { adminEmails, requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 50;

/** Admin: every account, searchable by email or name, newest first. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const filter = url.searchParams.get("filter") ?? "all";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const period = new Date().toISOString().slice(0, 7);
  const sql = db();

  const where = sql`
    where (${q} = '' or lower(u.email) like ${like} or lower(coalesce(p.full_name, '')) like ${like} or coalesce(p.phone, '') like ${like})
      and (
        ${filter} = 'all'
        or (${filter} = 'paying' and p.subscription_status in ('active', 'past_due'))
        or (${filter} = 'trial' and p.subscription_status = 'authenticated')
        or (${filter} = 'free' and (p.plan is null or p.subscription_status in ('none', 'cancelled', 'halted')))
        or (${filter} = 'admins' and u.is_admin)
        or (${filter} = 'suspended' and u.suspended_at is not null)
      )`;

  const [rows, [{ total }]] = await Promise.all([
    sql<
      {
        id: string;
        email: string;
        name: string | null;
        phone: string | null;
        created_at: Date;
        is_admin: boolean;
        suspended_at: Date | null;
        plan: string | null;
        subscription_status: string | null;
        legacy_unlimited: boolean | null;
        stores: number;
        orders: number;
        sent: number;
      }[]
    >`
      select u.id, u.email, p.full_name as name, p.phone, u.created_at, u.is_admin, u.suspended_at,
             p.plan, p.subscription_status, p.legacy_unlimited,
             (select count(*)::int from stores s where s.user_id = u.id) as stores,
             (select coalesce(sum(order_count), 0)::int from stores s where s.user_id = u.id) as orders,
             coalesce((select sent_count from whatsapp_usage w where w.user_id = u.id and w.period = ${period}), 0)::int as sent
      from users u left join profiles p on p.id = u.id
      ${where}
      order by u.created_at desc
      limit ${PAGE} offset ${(page - 1) * PAGE}`,
    sql<{ total: number }[]>`select count(*)::int as total from users u left join profiles p on p.id = u.id ${where}`,
  ]);

  const envAdmins = adminEmails();
  return NextResponse.json({
    page,
    pageSize: PAGE,
    total,
    users: rows.map((r) => ({
      ...r,
      created_at: r.created_at.toISOString(),
      suspended_at: r.suspended_at?.toISOString() ?? null,
      /** Admin through ADMIN_EMAILS — can't be revoked from the panel. */
      envAdmin: envAdmins.includes(r.email.toLowerCase()),
    })),
  });
}

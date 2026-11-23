"use client";

import Link from "next/link";
import { ago, day, inr, Kpi, LoadState, Panel, Pill, ReloadButton, useAdmin } from "./shared";

interface Overview {
  users: { total: number; d7: number; d30: number; admins: number; suspended: number };
  stores: { total: number; orders: number; customers: number; syncing: number };
  billing: {
    mrrPaise: number;
    revenue30Paise: number;
    revenueAllPaise: number;
    payments30: number;
    byPlan: { id: string; name: string; active: number; trial: number; pastDue: number }[];
  };
  messages: { period: string; sent: number; senders: number };
  webhooks: { lastReceivedAt: string | null; last24h: number };
  whatsapp: { linked: number; connected: number };
  signups: { day: string; n: number }[];
  recent: { id: string; email: string; created_at: string; plan: string | null }[];
}

export function AdminOverview({ openUser }: { openUser: (id: string) => void }) {
  const { data, error, loading, reload } = useAdmin<Overview>("/api/admin/overview");
  const max = Math.max(1, ...(data?.signups.map((s) => s.n) ?? [1]));

  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? (
        <div className="space-y-6">
          <div className="flex justify-end">
            <ReloadButton loading={loading} onClick={reload} />
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Monthly recurring revenue" value={inr(data.billing.mrrPaise)} hint="Active + past-due subscriptions" />
            <Kpi label="Collected, last 30 days" value={inr(data.billing.revenue30Paise)} hint={`${data.billing.payments30} payments · ${inr(data.billing.revenueAllPaise)} all time`} />
            <Kpi label="Accounts" value={data.users.total.toLocaleString("en-IN")} hint={`+${data.users.d7} this week · +${data.users.d30} in 30 days`} />
            <Kpi label="Connected stores" value={data.stores.total.toLocaleString("en-IN")} hint={`${data.stores.orders.toLocaleString("en-IN")} orders synced${data.stores.syncing ? ` · ${data.stores.syncing} importing` : ""}`} />
            <Kpi label={`WhatsApp messages (${data.messages.period})`} value={data.messages.sent.toLocaleString("en-IN")} hint={`from ${data.messages.senders} accounts`} />
            <Kpi label="Linked WhatsApp numbers" value={`${data.whatsapp.connected} / ${data.whatsapp.linked}`} hint="connected / linked on this server" />
            <Kpi
              label="Razorpay webhook"
              value={data.webhooks.lastReceivedAt ? ago(data.webhooks.lastReceivedAt) : "Never"}
              hint={`${data.webhooks.last24h} events in 24 h`}
            />
            <Kpi label="Admins · suspended" value={`${data.users.admins} · ${data.users.suspended}`} hint="Admins granted from this panel" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Panel title="Sign-ups, last 30 days" description={`${data.signups.reduce((a, s) => a + s.n, 0)} new accounts`}>
              <div className="flex h-36 items-end gap-[3px]" role="img" aria-label="Daily sign-ups for the last 30 days">
                {data.signups.map((s) => (
                  <div key={s.day} className="group relative flex h-full flex-1 items-end">
                    <div
                      className="w-full rounded-t-[3px] bg-data/70 transition-colors group-hover:bg-data"
                      style={{ height: `${Math.max(s.n ? 6 : 2, (s.n / max) * 100)}%`, opacity: s.n ? 1 : 0.25 }}
                    />
                    <span className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 rounded-md bg-foreground px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-background group-hover:block">
                      {day(s.day)}: {s.n}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-ink-3">
                <span>{day(data.signups[0]?.day)}</span>
                <span>Today</span>
              </div>
            </Panel>

            <Panel title="Subscriptions by plan">
              <div className="space-y-3">
                {data.billing.byPlan.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="flex flex-wrap justify-end gap-1.5">
                      <Pill tone="good">{p.active} active</Pill>
                      <Pill tone="info">{p.trial} trial</Pill>
                      {p.pastDue ? <Pill tone="warn">{p.pastDue} past due</Pill> : null}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <Panel title="Newest accounts" flush>
            <ul className="divide-y divide-line">
              {data.recent.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => openUser(u.id)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-hover sm:px-5"
                  >
                    <span className="min-w-0 truncate">{u.email}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
                      {u.plan ? <Pill>{u.plan}</Pill> : null}
                      {ago(u.created_at)}
                    </span>
                  </button>
                </li>
              ))}
              {data.recent.length === 0 ? <li className="px-5 py-6 text-sm text-ink-3">No accounts yet.</li> : null}
            </ul>
          </Panel>

          {!data.webhooks.lastReceivedAt ? (
            <p className="text-xs text-ink-3">
              No Razorpay webhook has arrived yet — subscriptions won&apos;t activate until it does.{" "}
              <Link href="/admin?tab=billing" className="text-data hover:underline">
                Set it up
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </LoadState>
  );
}

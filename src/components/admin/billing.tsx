"use client";

import { Check, CircleAlert, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ago, day, inr, LoadState, Panel, Pill, ReloadButton, ScrollTable, StatusPill, useAdmin, when } from "./shared";

interface BillingResponse {
  billingEnabled: boolean;
  keyMode: "live" | "test" | null;
  webhook: {
    url: string;
    secretSet: boolean;
    events: string[];
    received: number;
    lastReceivedAt: string | null;
    recent: { event_type: string; received_at: string }[];
  };
  subscriptions: {
    id: string;
    email: string;
    plan: string | null;
    subscription_status: string;
    razorpay_subscription_id: string | null;
    current_period_end: string | null;
    trial_ends_at: string | null;
    comp_until: string | null;
    legacy_unlimited: boolean;
  }[];
  invoices: { id: string; user_id: string; email: string | null; plan: string; amount_paise: number; status: string; paid_at: string; razorpay_payment_id: string | null }[];
}

export function AdminBilling({ openUser }: { openUser: (id: string) => void }) {
  const { data, error, loading, reload } = useAdmin<BillingResponse>("/api/admin/billing");

  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-3">Razorpay:</span>
              {data.keyMode ? <Pill tone={data.keyMode === "live" ? "good" : "warn"}>{data.keyMode} mode</Pill> : <Pill tone="bad">not configured</Pill>}
              <span className="text-ink-3">Webhook:</span>
              {data.webhook.lastReceivedAt ? (
                <Pill tone="good">working · last event {ago(data.webhook.lastReceivedAt)}</Pill>
              ) : (
                <Pill tone="warn">no events received yet</Pill>
              )}
            </div>
            <ReloadButton loading={loading} onClick={reload} />
          </div>

          <WebhookGuide webhook={data.webhook} keyMode={data.keyMode} />

          <Panel title="Subscriptions" description="Every account with a plan, a Razorpay subscription, or unlimited access." flush>
            <ScrollTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4 sm:pl-5">Account</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Renews / ends</TableHead>
                    <TableHead className="pr-4 sm:pr-5">Razorpay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.subscriptions.map((s) => (
                    <TableRow key={s.id} className="cursor-pointer" onClick={() => openUser(s.id)}>
                      <TableCell className="max-w-[240px] truncate pl-4 font-medium sm:pl-5">{s.email}</TableCell>
                      <TableCell className="capitalize">{s.legacy_unlimited ? "Unlimited" : (s.plan ?? "—")}</TableCell>
                      <TableCell>
                        {s.comp_until && new Date(s.comp_until) > new Date() ? <Pill tone="info">granted</Pill> : <StatusPill status={s.subscription_status} />}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-ink-3">
                        {s.comp_until && new Date(s.comp_until) > new Date()
                          ? `free until ${day(s.comp_until)}`
                          : s.subscription_status === "authenticated"
                            ? `trial ends ${day(s.trial_ends_at)}`
                            : day(s.current_period_end)}
                      </TableCell>
                      <TableCell className="pr-4 sm:pr-5">
                        {s.razorpay_subscription_id ? <code className="text-xs text-ink-3">{s.razorpay_subscription_id}</code> : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.subscriptions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-sm text-ink-3">
                        No subscriptions yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </ScrollTable>
          </Panel>

          <Panel title="Payments" description="Recorded from Razorpay's subscription.charged webhook." flush>
            <ScrollTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4 sm:pl-5">Date</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="pr-4 sm:pr-5">Payment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.invoices.map((i) => (
                    <TableRow key={i.id} className="cursor-pointer" onClick={() => openUser(i.user_id)}>
                      <TableCell className="pl-4 text-xs whitespace-nowrap sm:pl-5">{when(i.paid_at)}</TableCell>
                      <TableCell className="max-w-[220px] truncate">{i.email ?? "—"}</TableCell>
                      <TableCell className="capitalize">{i.plan}</TableCell>
                      <TableCell className="text-right tabular-nums">{inr(i.amount_paise)}</TableCell>
                      <TableCell className="pr-4 sm:pr-5">
                        <code className="text-xs text-ink-3">{i.razorpay_payment_id ?? "—"}</code>
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.invoices.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-sm text-ink-3">
                        No payments yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </ScrollTable>
          </Panel>
        </div>
      ) : null}
    </LoadState>
  );
}

function WebhookGuide({ webhook, keyMode }: { webhook: BillingResponse["webhook"]; keyMode: "live" | "test" | null }) {
  const steps: { title: string; body: React.ReactNode }[] = [
    {
      title: `Open Razorpay in ${keyMode ?? "live"} mode`,
      body: (
        <>
          Sign in to the{" "}
          <a href="https://dashboard.razorpay.com/app/webhooks" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-data hover:underline">
            Razorpay Dashboard <ExternalLink className="size-3" />
          </a>
          . Check the mode switch at the top matches your key ({keyMode ?? "unknown"}). Webhooks are set up separately for test and live mode.
        </>
      ),
    },
    { title: "Go to Accounts & Settings → Webhooks", body: <>Under <b>Website and app settings</b>, click <b>Webhooks</b>, then <b>+ Add New Webhook</b>.</> },
    { title: "Webhook URL", body: <CopyField value={webhook.url} /> },
    {
      title: "Secret",
      body: webhook.secretSet ? (
        <>Paste the value of <code>RAZORPAY_WEBHOOK_SECRET</code> from the server&apos;s settings (.env locally, App Service configuration on Azure). It&apos;s set on this server. It&apos;s not shown here on purpose.</>
      ) : (
        <span className="text-amber-700 dark:text-amber-300">
          <code>RAZORPAY_WEBHOOK_SECRET</code> isn&apos;t set on this server. Generate one (<code>openssl rand -hex 24</code>), add it to the server&apos;s settings, restart, then paste the same value here.
        </span>
      ),
    },
    {
      title: "Active events — tick these",
      body: (
        <div className="flex flex-wrap gap-1.5">
          {webhook.events.map((e) => (
            <code key={e} className="rounded-[5px] bg-hover px-1.5 py-0.5 text-[11.5px]">
              {e}
            </code>
          ))}
        </div>
      ),
    },
    { title: "Create Webhook", body: <>Add an alert email if you want failure notices, then click <b>Create Webhook</b>. Razorpay&apos;s next event shows up below within seconds.</> },
  ];

  return (
    <Panel
      title="Razorpay webhook"
      description="Razorpay tells this server when a trial starts, a payment succeeds or fails, or a subscription ends. Without it, subscriptions never turn active."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-medium">{i + 1}</span>
              <div className="min-w-0 space-y-1 pt-0.5">
                <p className="text-sm font-medium">{s.title}</p>
                <div className="text-[13px] leading-relaxed text-ink-2">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-3">Recent deliveries ({webhook.received} total)</p>
          {webhook.recent.length === 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-line p-3 text-[13px] text-ink-3">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              Nothing yet. Once the webhook exists, start a test subscription and the events will appear here.
            </div>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {webhook.recent.map((e, i) => (
                <li key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <code>{e.event_type}</code>
                  <span className="text-ink-3">{ago(e.received_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-hover px-2 py-1.5 text-xs">{value}</code>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="size-8 shrink-0"
        aria-label="Copy webhook URL"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            toast.success("Copied.");
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

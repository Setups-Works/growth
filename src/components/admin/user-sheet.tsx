"use client";

import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { adminSend, ago, day, inr, LoadState, Pill, StatusPill, useAdmin, when } from "./shared";

interface Detail {
  user: {
    id: string;
    email: string;
    name: string | null;
    phone: string | null;
    created_at: string;
    is_admin: boolean;
    envAdmin: boolean;
    suspended_at: string | null;
    plan: string | null;
    subscription_status: string | null;
    razorpay_customer_id: string | null;
    razorpay_subscription_id: string | null;
    current_period_end: string | null;
    grace_until: string | null;
    legacy_unlimited: boolean | null;
    trial_ends_at: string | null;
    trial_used_at: string | null;
    comp_until: string | null;
  };
  stores: { id: string; url: string; name: string | null; order_count: number; last_sync_at: string | null; backfill_done: boolean }[];
  usage: { period: string; sent_count: number }[];
  invoices: { id: string; plan: string; amount_paise: number; status: string; paid_at: string }[];
  apiKeys: number;
  whatsapp: { status: string; phone: string | null } | null;
  history: { admin_email: string; action: string; created_at: string }[];
}

export function UserSheet({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">{id ? <Body id={id} onChanged={onChanged} /> : null}</SheetContent>
    </Sheet>
  );
}

function Body({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useAdmin<Detail>(`/api/admin/users/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [grantPlan, setGrantPlan] = useState("go");
  const [grantDays, setGrantDays] = useState("30");

  const act = async (action: string, extra: Record<string, unknown> = {}, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    const ok = await adminSend(`/api/admin/users/${id}`, "PATCH", { action, ...extra }, "Saved.");
    setBusy(null);
    if (ok) {
      await reload();
      onChanged();
    }
  };

  const u = data?.user;
  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle className="truncate pr-6">{u?.email ?? "Account"}</SheetTitle>
        <SheetDescription>
          {u ? `Joined ${day(u.created_at)}${u.name ? ` · ${u.name}` : ""}${u.phone ? ` · ${u.phone}` : ""}` : " "}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-6 px-4 pb-8">
        <LoadState error={error} loading={loading && !data}>
          {u && data ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {u.is_admin || u.envAdmin ? <Pill tone="info">admin{u.envAdmin ? " (ADMIN_EMAILS)" : ""}</Pill> : null}
                {u.suspended_at ? <Pill tone="bad">suspended {ago(u.suspended_at)}</Pill> : null}
                {u.legacy_unlimited ? <Pill tone="good">unlimited</Pill> : null}
                {data.whatsapp ? <Pill tone={data.whatsapp.status === "ready" ? "good" : "muted"}>WhatsApp {data.whatsapp.status}</Pill> : null}
                <Pill>{data.apiKeys} API keys</Pill>
              </div>

              <Section title="Plan">
                <Row label="Plan" value={<span className="capitalize">{u.plan ?? "None"}</span>} />
                <Row label="Status" value={<StatusPill status={u.subscription_status} />} />
                {u.comp_until ? <Row label="Granted free until" value={day(u.comp_until)} /> : null}
                {u.trial_ends_at ? <Row label="Trial ends" value={day(u.trial_ends_at)} /> : null}
                {u.current_period_end ? <Row label="Renews" value={day(u.current_period_end)} /> : null}
                {u.grace_until ? <Row label="Grace until" value={when(u.grace_until)} /> : null}
                <Row label="Trial used" value={u.trial_used_at ? day(u.trial_used_at) : "No"} />
                {u.razorpay_subscription_id ? <Row label="Razorpay subscription" value={<code className="text-xs">{u.razorpay_subscription_id}</code>} /> : null}
              </Section>

              <Section title="Grant a plan for free">
                <div className="flex flex-wrap items-end gap-2">
                  <Select value={grantPlan} onValueChange={setGrantPlan}>
                    <SelectTrigger className="w-28" aria-label="Plan to grant">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lite">Lite</SelectItem>
                      <SelectItem value="go">Go</SelectItem>
                      <SelectItem value="plus">Plus</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1.5">
                    <Input value={grantDays} onChange={(e) => setGrantDays(e.target.value.replace(/\D/g, ""))} className="w-20" inputMode="numeric" aria-label="Days" />
                    <span className="text-xs text-ink-3">days</span>
                  </div>
                  <ActionButton busy={busy} id="grant_plan" onClick={() => act("grant_plan", { plan: grantPlan, days: Number(grantDays) || 30 })}>
                    Grant
                  </ActionButton>
                </div>
                <p className="text-xs text-ink-3">No payment is taken. The plan lapses on its own after the period.</p>
              </Section>

              <Section title="Actions">
                <div className="flex flex-wrap gap-2">
                  <ActionButton busy={busy} id="set_unlimited" variant="outline" onClick={() => act("set_unlimited", { value: !u.legacy_unlimited })}>
                    {u.legacy_unlimited ? "Remove unlimited" : "Make unlimited"}
                  </ActionButton>
                  <ActionButton busy={busy} id="reset_usage" variant="outline" onClick={() => act("reset_usage", {}, "Reset this month's message count to zero?")}>
                    Reset message count
                  </ActionButton>
                  {u.trial_used_at ? (
                    <ActionButton busy={busy} id="reset_trial" variant="outline" onClick={() => act("reset_trial")}>
                      Allow another free trial
                    </ActionButton>
                  ) : null}
                  {u.plan ? (
                    <ActionButton busy={busy} id="clear_plan" variant="outline" onClick={() => act("clear_plan", {}, "Remove this account's plan? Any Razorpay subscription keeps running unless you cancel it too.")}>
                      Remove plan
                    </ActionButton>
                  ) : null}
                  {u.razorpay_subscription_id && u.subscription_status !== "cancelled" ? (
                    <ActionButton busy={busy} id="cancel_subscription" variant="outline" onClick={() => act("cancel_subscription", {}, "Cancel the Razorpay subscription now? No further charges will be made.")}>
                      Cancel subscription
                    </ActionButton>
                  ) : null}
                  {!u.envAdmin ? (
                    <ActionButton busy={busy} id="set_admin" variant="outline" onClick={() => act("set_admin", { value: !u.is_admin }, u.is_admin ? undefined : `Give ${u.email} full admin access?`)}>
                      {u.is_admin ? "Remove admin" : "Make admin"}
                    </ActionButton>
                  ) : null}
                  <ActionButton
                    busy={busy}
                    id="suspend"
                    variant={u.suspended_at ? "outline" : "destructive"}
                    onClick={() => act("suspend", { value: !u.suspended_at }, u.suspended_at ? undefined : `Suspend ${u.email}? They are signed out everywhere and can't sign in.`)}
                  >
                    {u.suspended_at ? "Unsuspend" : "Suspend account"}
                  </ActionButton>
                </div>
              </Section>

              <Section title={`Stores (${data.stores.length})`}>
                {data.stores.length === 0 ? <p className="text-sm text-ink-3">No store connected.</p> : null}
                {data.stores.map((s) => (
                  <Row
                    key={s.id}
                    label={<span className="truncate">{s.name || s.url.replace(/^https?:\/\//, "")}</span>}
                    value={
                      <span className="text-xs text-ink-3">
                        {s.order_count.toLocaleString("en-IN")} orders · {s.backfill_done ? `synced ${ago(s.last_sync_at)}` : "importing"}
                      </span>
                    }
                  />
                ))}
              </Section>

              <Section title="WhatsApp messages">
                {data.usage.length === 0 ? <p className="text-sm text-ink-3">None sent yet.</p> : null}
                {data.usage.map((m) => (
                  <Row key={m.period} label={m.period} value={<span className="tabular-nums">{m.sent_count.toLocaleString("en-IN")}</span>} />
                ))}
              </Section>

              <Section title="Payments">
                {data.invoices.length === 0 ? <p className="text-sm text-ink-3">No payments.</p> : null}
                {data.invoices.map((i) => (
                  <Row key={i.id} label={`${day(i.paid_at)} · ${i.plan}`} value={<span className="tabular-nums">{inr(i.amount_paise)}</span>} />
                ))}
              </Section>

              {data.history.length ? (
                <Section title="Admin history">
                  {data.history.map((h, i) => (
                    <Row key={i} label={<span className="font-mono text-xs">{h.action}</span>} value={<span className="text-xs text-ink-3">{h.admin_email} · {ago(h.created_at)}</span>} />
                  ))}
                </Section>
              ) : null}
            </>
          ) : null}
        </LoadState>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 text-ink-2">{label}</span>
      <span className="shrink-0 text-right">{value}</span>
    </div>
  );
}

function ActionButton({
  busy,
  id,
  children,
  onClick,
  variant = "default",
}: {
  busy: string | null;
  id: string;
  children: ReactNode;
  onClick: () => void;
  variant?: "default" | "outline" | "destructive";
}) {
  return (
    <Button type="button" size="sm" variant={variant} disabled={busy !== null} onClick={onClick} className="gap-1.5">
      {busy === id ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {children}
    </Button>
  );
}

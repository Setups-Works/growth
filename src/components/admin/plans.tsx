"use client";

import { CircleAlert, ExternalLink, Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminSend, day, inr, LoadState, Panel, Pill, ReloadButton, useAdmin } from "./shared";

interface RzpPlan {
  id: string;
  name: string;
  amountPaise: number;
  currency: string;
  period: string;
  interval: number;
  createdAt: number;
  ours: boolean;
}

interface AdminPlan {
  id: "lite" | "go" | "plus";
  name: string;
  pricePaise: number;
  cadence: string;
  blurb: string;
  features: string[];
  messageLimit: number | null;
  whatsapp: boolean;
  highlight: boolean;
  trialDays: number;
  razorpayPlanId: string | null;
  linkedPlanId: string | null;
  linkedFrom: "admin" | "env" | null;
  linked: RzpPlan | null;
  priceMismatch: boolean;
  subscribers: number;
}

interface PlansResponse {
  billingEnabled: boolean;
  razorpayError: string | null;
  plans: AdminPlan[];
  razorpayPlans: RzpPlan[];
}

export function AdminPlans() {
  const { data, error, loading, reload } = useAdmin<PlansResponse>("/api/admin/plans");

  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? (
        <div className="space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-2xl text-sm text-ink-3">
              What you set here is what the pricing pages, Settings → Billing, checkout and the WhatsApp send limit all use, within a minute.
              To charge a new price, save it and then create a matching Razorpay plan.
            </p>
            <ReloadButton loading={loading} onClick={reload} />
          </div>

          {!data.billingEnabled ? (
            <Alert>
              <CircleAlert />
              <AlertTitle>Billing is off</AlertTitle>
              <AlertDescription>
                RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET aren&apos;t set, so every account gets every feature for free.
              </AlertDescription>
            </Alert>
          ) : null}
          {data.razorpayError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Couldn&apos;t reach Razorpay</AlertTitle>
              <AlertDescription>{data.razorpayError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-3">
            {data.plans.map((p) => (
              <PlanEditor key={`${p.id}-${p.razorpayPlanId}-${p.pricePaise}`} plan={p} razorpayPlans={data.razorpayPlans} billingEnabled={data.billingEnabled} onSaved={reload} />
            ))}
          </div>

          {data.razorpayPlans.length ? (
            <Panel
              title="Plans on your Razorpay account"
              description="Newest first, across every site on this account. Only plans made by Growth can be linked above. Razorpay plans can't be edited or deleted."
              flush
            >
              <ul className="divide-y divide-line">
                {data.razorpayPlans.map((r) => {
                  const usedBy = data.plans.filter((p) => p.linkedPlanId === r.id).map((p) => p.name);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                      <span className="min-w-0">
                        <span className="font-medium">{r.name}</span>{" "}
                        <code className="text-xs text-ink-3">{r.id}</code>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        {usedBy.length ? <Pill tone="good">linked to {usedBy.join(", ")}</Pill> : null}
                        {!r.ours && !usedBy.length ? <Pill>other site</Pill> : null}
                        {r.currency === "INR" ? inr(r.amountPaise) : `${r.amountPaise / 100} ${r.currency}`} / {r.interval > 1 ? `${r.interval} ` : ""}
                        {r.period.replace(/ly$/, "")} · {day(new Date(r.createdAt * 1000).toISOString())}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </LoadState>
  );
}

function PlanEditor({
  plan,
  razorpayPlans,
  billingEnabled,
  onSaved,
}: {
  plan: AdminPlan;
  razorpayPlans: RzpPlan[];
  billingEnabled: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const [price, setPrice] = useState(String(plan.pricePaise / 100));
  const [cadence, setCadence] = useState(plan.cadence);
  const [blurb, setBlurb] = useState(plan.blurb);
  const [features, setFeatures] = useState<string[]>(plan.features);
  const [whatsapp, setWhatsapp] = useState(plan.whatsapp);
  const [unlimited, setUnlimited] = useState(plan.messageLimit === null);
  const [limit, setLimit] = useState(String(plan.messageLimit ?? 10000));
  const [trialDays, setTrialDays] = useState(String(plan.trialDays));
  const [highlight, setHighlight] = useState(plan.highlight);
  const [rzpId, setRzpId] = useState(plan.razorpayPlanId ?? "");
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const pricePaise = Math.round(Number(price) * 100);
  const save = async () => {
    setSaving(true);
    const ok = await adminSend(
      "/api/admin/plans",
      "PUT",
      {
        id: plan.id,
        name,
        pricePaise: Number.isFinite(pricePaise) ? pricePaise : 0,
        cadence,
        blurb,
        features: features.map((f) => f.trim()).filter(Boolean),
        messageLimit: unlimited ? null : Number(limit) || 0,
        whatsapp,
        highlight,
        trialDays: Number(trialDays) || 0,
        razorpayPlanId: rzpId.trim() || null,
      },
      `${name} saved.`,
    );
    setSaving(false);
    if (ok) onSaved();
  };

  const createRzp = async () => {
    if (!window.confirm(`Create a new Razorpay plan "Setups Works Growth ${plan.name}" at ${inr(plan.pricePaise)}/month and use it for new ${plan.name} subscriptions?`)) return;
    setCreating(true);
    const ok = await adminSend(`/api/admin/plans/${plan.id}/razorpay`, "POST", {}, "Razorpay plan created and linked.");
    setCreating(false);
    if (ok) onSaved();
  };

  const dirtyPrice = pricePaise !== plan.pricePaise;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {plan.name}
          <span className="text-xs font-normal text-ink-3">({plan.id})</span>
          {plan.highlight ? <Pill tone="info">recommended</Pill> : null}
        </span>
      }
      description={`${plan.subscribers} on this plan now`}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Price (₹ / month)">
            <Input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" />
          </Field>
        </div>
        <Field label="Cadence label">
          <Input value={cadence} onChange={(e) => setCadence(e.target.value)} maxLength={30} />
        </Field>
        <Field label="Short description">
          <Textarea value={blurb} onChange={(e) => setBlurb(e.target.value)} rows={2} maxLength={200} />
        </Field>

        <div className="space-y-2">
          <Label className="text-xs">Feature list (pricing cards)</Label>
          {features.map((f, i) => (
            <div key={i} className="flex gap-1.5">
              <Input
                value={f}
                maxLength={160}
                onChange={(e) => setFeatures(features.map((x, j) => (j === i ? e.target.value : x)))}
                aria-label={`Feature ${i + 1}`}
              />
              <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => setFeatures(features.filter((_, j) => j !== i))} aria-label="Remove feature">
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          {features.length < 15 ? (
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setFeatures([...features, ""])}>
              <Plus className="size-3.5" /> Add feature
            </Button>
          ) : null}
        </div>

        <div className="space-y-3 rounded-lg border border-line p-3">
          <Toggle label="Includes WhatsApp" hint="Campaigns, flows, auto-reply, confirmations, assistant" checked={whatsapp} onChange={setWhatsapp} />
          {whatsapp ? (
            <>
              <Toggle label="Unlimited messages" checked={unlimited} onChange={setUnlimited} />
              {!unlimited ? (
                <Field label="Messages per month">
                  <Input value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
                </Field>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Free trial (days)">
            <Input value={trialDays} onChange={(e) => setTrialDays(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" />
          </Field>
          <div className="flex items-end pb-1.5">
            <Toggle label="Recommended" checked={highlight} onChange={setHighlight} />
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-xs font-medium">Razorpay plan</p>
          {plan.linked ? (
            <p className="text-xs text-ink-3">
              Charging <span className="font-medium text-foreground">{inr(plan.linked.amountPaise)}</span> on{" "}
              <code>{plan.linked.id}</code>
              {plan.linkedFrom === "env" ? " (from RAZORPAY_PLAN_ID env)" : ""}
            </p>
          ) : plan.linkedPlanId ? (
            <p className="text-xs text-ink-3">
              Linked to <code>{plan.linkedPlanId}</code>, which wasn&apos;t found on this Razorpay account.
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-300">No Razorpay plan linked — checkout for {plan.name} won&apos;t work.</p>
          )}
          {plan.priceMismatch ? (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              The price shown ({inr(plan.pricePaise)}) differs from what Razorpay charges. Create a new Razorpay plan to fix it.
            </p>
          ) : null}
          <Select value={rzpId || "__none"} onValueChange={(v) => setRzpId(v === "__none" ? "" : v)}>
            <SelectTrigger className="w-full" aria-label="Linked Razorpay plan">
              <SelectValue placeholder="Choose a Razorpay plan" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Use RAZORPAY_PLAN_ID_{plan.id.toUpperCase()} env</SelectItem>
              {razorpayPlans
                // Growth's own monthly plans only — this Razorpay account also holds other sites' plans.
                .filter((r) => r.period === "monthly" && r.interval === 1 && (r.ours || r.id === plan.linkedPlanId))
                .map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} — {r.currency === "INR" ? inr(r.amountPaise) : `${r.amountPaise / 100} ${r.currency}`}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {billingEnabled ? (
            <Button type="button" variant="outline" size="sm" className="w-full gap-1.5" disabled={creating || dirtyPrice} onClick={createRzp}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
              {dirtyPrice ? "Save the new price first" : `Create Razorpay plan at ${inr(plan.pricePaise)}`}
            </Button>
          ) : null}
        </div>

        <Button type="button" className="w-full gap-1.5" disabled={saving} onClick={save}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save {name || plan.name}
        </Button>
      </div>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint ? <span className="block text-xs text-ink-3">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

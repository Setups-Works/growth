"use client";

import { CalendarDays, CreditCard, Loader2, Mail, Phone, Store, User2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBilling } from "@/components/providers/billing-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { normaliseName, normalisePhone } from "@/lib/auth/fields";

interface Account {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  createdAt: string;
  plan: string | null;
  subscriptionStatus: string;
  stores: number;
}

type Field = "name" | "email" | "phone" | "currentPassword";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUS: Record<string, string> = {
  active: "Active",
  authenticated: "Free trial",
  past_due: "Payment failed — grace period",
  created: "Awaiting payment",
  halted: "Halted",
  cancelled: "Cancelled",
  none: "No plan",
};

/**
 * Settings → Profile: who you are on this account, editable, plus a summary
 * of your plan and stores. The password lives next door in Settings →
 * Security; `go` switches section without leaving the page.
 */
export function ProfileSection({ go }: { go: (section: "billing" | "security" | "store") => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load your account.");
      setAccount(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your account.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (error) return <p className="text-sm text-ink-3">{error}</p>;
  if (!account) {
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Skeleton className="h-80" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <ProfileForm key={`${account.name}|${account.email}|${account.phone}`} account={account} onSaved={load} />
      <Summary account={account} go={go} />
    </div>
  );
}

function ProfileForm({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const { refresh } = useBilling();
  const [name, setName] = useState(account.name ?? "");
  const [email, setEmail] = useState(account.email);
  const [phone, setPhone] = useState(account.phone ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== account.email.toLowerCase();
  const dirty = name.trim() !== (account.name ?? "") || emailChanged || (normalisePhone(phone) ?? phone) !== (account.phone ?? "");

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    if (!normaliseName(name)) found.name = "Enter your full name.";
    if (!EMAIL.test(email.trim())) found.email = "Enter a valid email address.";
    if (!normalisePhone(phone)) found.phone = "Enter a valid mobile number.";
    if (emailChanged && !currentPassword) found.currentPassword = "Enter your current password to change your email.";
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone, email: email.trim(), ...(emailChanged ? { currentPassword } : {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; field?: Field };
      if (!res.ok) {
        if (json.field) setErrors({ [json.field]: json.error });
        else toast.error(json.error ?? "Couldn't save your details.");
        return;
      }
      toast.success("Your details are saved.");
      setCurrentPassword("");
      onSaved();
      refresh();
    } catch {
      toast.error("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const formatted = normalisePhone(phone);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <User2 className="size-4" />
          Your details
        </CardTitle>
        <CardDescription className="text-[13px]">
          Used on your invoices and Razorpay receipts, and to reach you about your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} noValidate className="space-y-4">
          <Row id="name" label="Full name" error={errors.name}>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} aria-invalid={Boolean(errors.name)} />
          </Row>
          <div className="grid gap-4 sm:grid-cols-2">
            <Row id="email" label="Email" error={errors.email} hint={emailChanged ? "Sign-in and password resets will use the new address." : undefined}>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" aria-invalid={Boolean(errors.email)} />
            </Row>
            <Row
              id="phone"
              label="Mobile number"
              error={errors.phone}
              hint={formatted && formatted !== account.phone ? `Will be saved as ${formatted}` : account.phone ? undefined : "Add a number for payment OTPs and support."}
            >
              <Input id="phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="98765 43210" maxLength={20} aria-invalid={Boolean(errors.phone)} />
            </Row>
          </div>
          {emailChanged ? (
            <Row id="currentPassword" label="Current password" error={errors.currentPassword} hint="Needed to change the email on your account.">
              <Input id="currentPassword" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" aria-invalid={Boolean(errors.currentPassword)} />
            </Row>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" disabled={saving || !dirty} className="gap-1.5">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save changes
            </Button>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setName(account.name ?? "");
                  setEmail(account.email);
                  setPhone(account.phone ?? "");
                  setCurrentPassword("");
                  setErrors({});
                }}
              >
                Discard
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Summary({ account, go }: { account: Account; go: (section: "billing" | "security" | "store") => void }) {
  const { status } = useBilling();
  const planName = status?.plans.find((p) => p.id === account.plan)?.name ?? account.plan;
  const initials = (account.name || account.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  return (
    <Card>
      <CardContent className="space-y-5 pt-1">
        <div className="flex items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground">
            {initials || "?"}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{account.name || "No name yet"}</p>
            <p className="truncate text-[13px] text-ink-3">{account.email}</p>
          </div>
        </div>
        <ul className="space-y-2.5 text-sm">
          <Item icon={<Mail className="size-4" />} label="Email" value={account.email} />
          <Item icon={<Phone className="size-4" />} label="Mobile" value={account.phone ?? "Not added"} />
          <Item icon={<CalendarDays className="size-4" />} label="Member since" value={new Date(account.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })} />
          <Item icon={<Store className="size-4" />} label="Stores" value={String(account.stores)} />
          <Item
            icon={<CreditCard className="size-4" />}
            label="Plan"
            value={status?.legacyUnlimited ? "Unlimited" : planName ? `${planName} · ${STATUS[account.subscriptionStatus] ?? account.subscriptionStatus}` : "No plan"}
          />
        </ul>
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button type="button" size="sm" variant="outline" onClick={() => go("billing")}>
            Billing & invoices
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => go("security")}>
            Change password
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Item({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="text-ink-3">{icon}</span>
      <span className="w-28 shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 truncate font-medium">{value}</span>
    </li>
  );
}

function Row({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      {children}
      {error ? <p className="text-[11.5px] text-destructive">{error}</p> : hint ? <p className="text-[11.5px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

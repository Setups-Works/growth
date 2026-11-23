"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD } from "@/lib/auth/client";
import { normaliseName, normalisePhone, passwordScore } from "@/lib/auth/fields";
import { cn } from "@/lib/utils";

type Field = "name" | "email" | "phone" | "password" | "confirm" | "terms";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STRENGTH = [
  { label: "Too short", cls: "bg-destructive" },
  { label: "Weak", cls: "bg-destructive" },
  { label: "Fair", cls: "bg-amber-500" },
  { label: "Good", cls: "bg-primary" },
  { label: "Strong", cls: "bg-success" },
];

/**
 * Creating an account: name, email, mobile number and a password (typed
 * twice). Each field is checked as you leave it, with the same rules the
 * server applies (src/lib/auth/fields.ts), and the server's answer for a
 * specific field — "that email already has an account" — lands under that
 * field rather than in a generic banner.
 */
export function SignUpForm({ next }: { next: string }) {
  const router = useRouter();
  const params = useSearchParams();

  const [values, setValues] = useState({ name: "", email: "", phone: "", password: "", confirm: "" });
  const [terms, setTerms] = useState(false);
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(params.get("error"));
  const [pending, setPending] = useState(false);

  const problems: Partial<Record<Field, string>> = {
    name: normaliseName(values.name) ? undefined : "Enter your full name.",
    email: EMAIL.test(values.email.trim()) ? undefined : "Enter a valid email address.",
    phone: normalisePhone(values.phone) ? undefined : "Enter a valid mobile number.",
    password: values.password.length >= MIN_PASSWORD ? undefined : `Use at least ${MIN_PASSWORD} characters.`,
    confirm: !values.confirm
      ? "Type your password again."
      : values.confirm === values.password
        ? undefined
        : "The passwords don't match.",
    terms: terms ? undefined : "Please accept the terms to continue.",
  };
  const errorFor = (f: Field) => serverErrors[f] ?? (touched[f] ? problems[f] : undefined);
  const valid = Object.values(problems).every((p) => !p);

  const set = (f: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [f]: e.target.value }));
    if (serverErrors[f]) setServerErrors((s) => ({ ...s, [f]: undefined }));
  };
  const blur = (f: Field) => () => setTouched((t) => ({ ...t, [f]: true }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched({ name: true, email: true, phone: true, password: true, confirm: true, terms: true });
    if (!valid) return;
    setPending(true);
    setFormError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          email: values.email.trim(),
          phone: values.phone,
          password: values.password,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; field?: Field };
      if (!res.ok) {
        if (data.field) setServerErrors({ [data.field]: data.error });
        else setFormError(data.error ?? `Something went wrong (${res.status}).`);
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  const score = values.password.length < MIN_PASSWORD ? 0 : passwordScore(values.password);
  const phonePreview = normalisePhone(values.phone);
  const intl = /^\s*(\+|00)/.test(values.phone);

  return (
    <div className="space-y-5">
      <form onSubmit={submit} noValidate className="space-y-4">
        <FieldBox id="name" label="Full name" error={errorFor("name")}>
          <Input id="name" value={values.name} onChange={set("name")} onBlur={blur("name")} autoComplete="name" placeholder="Priya Sharma" aria-invalid={Boolean(errorFor("name"))} maxLength={80} />
        </FieldBox>

        <FieldBox id="email" label="Work email" error={errorFor("email")}>
          <Input id="email" type="email" value={values.email} onChange={set("email")} onBlur={blur("email")} autoComplete="email" placeholder="you@yourstore.com" aria-invalid={Boolean(errorFor("email"))} />
        </FieldBox>

        <FieldBox
          id="phone"
          label="Mobile number"
          error={errorFor("phone")}
          hint={phonePreview && !errorFor("phone") ? `Saved as ${phonePreview}` : "10-digit Indian number, or include your country code."}
        >
          <div className="flex">
            {/* The +91 hint goes away once someone types their own country code. */}
            {intl ? null : (
              <span className="inline-flex items-center rounded-l-[8px] border border-r-0 border-input bg-hover px-2.5 text-sm text-ink-3">+91</span>
            )}
            <Input
              id="phone"
              type="tel"
              inputMode="tel"
              value={values.phone}
              onChange={set("phone")}
              onBlur={blur("phone")}
              autoComplete="tel-national"
              placeholder="98765 43210"
              className={intl ? undefined : "rounded-l-none"}
              aria-invalid={Boolean(errorFor("phone"))}
              maxLength={20}
            />
          </div>
        </FieldBox>

        <FieldBox id="password" label="Password" error={errorFor("password")}>
          <div className="relative">
            <Input
              id="password"
              type={show ? "text" : "password"}
              value={values.password}
              onChange={set("password")}
              onBlur={blur("password")}
              autoComplete="new-password"
              className="pr-9"
              aria-invalid={Boolean(errorFor("password"))}
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-ink-3 hover:bg-hover hover:text-foreground"
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {values.password ? (
            <div className="flex items-center gap-2 pt-0.5" aria-live="polite">
              <div className="flex flex-1 gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className={cn("h-1 flex-1 rounded-full", i <= score ? STRENGTH[score].cls : "bg-line-2")} />
                ))}
              </div>
              <span className="w-14 text-right text-[11px] text-ink-3">{STRENGTH[score].label}</span>
            </div>
          ) : errorFor("password") ? null : (
            <p className="text-[11.5px] text-ink-3">At least {MIN_PASSWORD} characters. Longer is stronger.</p>
          )}
        </FieldBox>

        <FieldBox id="confirm" label="Confirm password" error={errorFor("confirm")}>
          <Input
            id="confirm"
            type={show ? "text" : "password"}
            value={values.confirm}
            onChange={set("confirm")}
            onBlur={blur("confirm")}
            autoComplete="new-password"
            aria-invalid={Boolean(errorFor("confirm"))}
          />
        </FieldBox>

        <div className="space-y-1.5">
          <label className="flex items-start gap-2.5 text-[13px] leading-snug text-ink-2">
            <Checkbox
              checked={terms}
              onCheckedChange={(v) => {
                setTerms(v === true);
                setTouched((t) => ({ ...t, terms: true }));
              }}
              className="mt-0.5"
              aria-invalid={Boolean(errorFor("terms"))}
            />
            <span>
              I agree to the{" "}
              <Link href="/terms" target="_blank" className="text-data underline-offset-2 hover:underline">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-data underline-offset-2 hover:underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          {errorFor("terms") ? <p className="text-[11.5px] text-destructive">{errorFor("terms")}</p> : null}
        </div>

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <Button type="submit" size="lg" className="h-10 w-full gap-1.5" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Create account
        </Button>
      </form>

      <p className="text-center text-[13px] text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-data underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function FieldBox({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[11.5px] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11.5px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

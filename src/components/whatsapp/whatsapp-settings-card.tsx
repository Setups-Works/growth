"use client";

import { CheckCircle2, Loader2, MessageCircle, Save, ShieldCheck, TriangleAlert, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useAnalytics } from "@/components/providers/analytics-provider";
import { WhatsAppLinkQr } from "@/components/whatsapp/whatsapp-link-qr";
import { dialCodeForCurrency } from "@/lib/whatsapp/phone";

interface Preferences {
  phone: string | null;
  defaultDialCode: string;
  delayBetweenMessagesMs: number;
  dailyLimit: number;
  quietStart: number | null;
  quietEnd: number | null;
  optOutFooter: boolean;
  updatedAt: string | null;
}

interface Capacity {
  dailyLimit: number;
  accountLimit: number;
  warmupDay: number | null;
  sentToday: number;
  hourlyLimit: number;
  sentThisHour: number;
  remaining: number;
  inQuietHours: boolean;
  pausedUntil: string | null;
}

interface SessionState {
  status: string;
  phone: string | null;
  pushName: string | null;
  lastError?: string | null;
}

interface SettingsResponse {
  available?: boolean;
  connected: boolean;
  config: Preferences | null;
  session: SessionState | null;
  ready?: boolean;
  capacity?: Capacity | null;
  error?: string | null;
}

/**
 * Links this account's WhatsApp number as a linked device — the same as
 * WhatsApp Web: scan the QR from WhatsApp → Linked devices on the phone.
 * Campaigns, flows, reminders and the menu bot all send through it.
 */
export function WhatsAppSettingsCard() {
  const [state, setState] = useState<SettingsResponse | null>(null);
  const [dialCode, setDialCode] = useState("");
  const [paceSeconds, setPaceSeconds] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [quietOn, setQuietOn] = useState(true);
  const [quietStart, setQuietStart] = useState("21");
  const [quietEnd, setQuietEnd] = useState("9");
  const [optOutFooter, setOptOutFooter] = useState(true);
  const [busy, setBusy] = useState(false);

  const { data } = useAnalytics();
  const suggestedDialCode = data ? dialCodeForCurrency(data.meta.currency) : "";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/whatsapp/settings", { cache: "no-store" });
      const body = (await res.json()) as SettingsResponse;
      setState(body);
      if (body.config) {
        setDialCode(body.config.defaultDialCode);
        setPaceSeconds(String(body.config.delayBetweenMessagesMs / 1000));
        setDailyLimit(String(body.config.dailyLimit));
        setQuietOn(body.config.quietStart !== null && body.config.quietEnd !== null);
        setQuietStart(String(body.config.quietStart ?? 21));
        setQuietEnd(String(body.config.quietEnd ?? 9));
        setOptOutFooter(body.config.optOutFooter);
      }
    } catch {
      setState({ connected: false, config: null, session: null, error: "Could not load WhatsApp settings." });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const savePreferences = async () => {
    setBusy(true);
    try {
      const seconds = Number(paceSeconds);
      const res = await fetch("/api/whatsapp/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultDialCode: (dialCode.trim() || suggestedDialCode).replace(/\D/g, ""),
          ...(Number.isFinite(seconds) && seconds > 0
            ? { delayBetweenMessagesMs: Math.round(seconds * 1000) }
            : {}),
          ...(Number(dailyLimit) > 0 ? { dailyLimit: Math.round(Number(dailyLimit)) } : {}),
          quietHours: quietOn
            ? { start: clampHour(quietStart, 21), end: clampHour(quietEnd, 9) }
            : { start: null, end: null },
          optOutFooter,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? "Could not save.");
        return;
      }
      toast.success("WhatsApp preferences saved.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!window.confirm("Unlink this WhatsApp number? Campaigns, flows and the menu bot stop sending until you link again.")) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp/settings", { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "Could not unlink.");
        return;
      }
      toast.success("WhatsApp number unlinked.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const session = state?.session;
  const ready = state?.ready ?? false;
  const linkedNumber = session?.phone ?? state?.config?.phone ?? null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <MessageCircle className="size-4 text-muted-foreground" />
              WhatsApp
            </CardTitle>
            <CardDescription className="text-xs">
              Link your WhatsApp Business (or personal) number as a linked device, like
              WhatsApp Web. Campaigns, flows, reminders and the menu bot all use it. Messages are never stored here — replies reach your phone.
            </CardDescription>
          </div>
          {state?.available !== false && state ? (
            <Badge variant={ready ? "default" : "secondary"} className="shrink-0 gap-1">
              {ready ? <CheckCircle2 className="size-3" /> : <TriangleAlert className="size-3" />}
              {ready ? "Linked" : session?.status === "initializing" ? "Connecting" : "Not linked"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {state?.error ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle className="text-xs font-medium">WhatsApp unavailable</AlertTitle>
            <AlertDescription className="text-xs">{state.error}</AlertDescription>
          </Alert>
        ) : null}

        {state?.available === false ? null : (
          <>
            {ready ? (
              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <Row label="Linked number" value={linkedNumber ? `+${linkedNumber}` : "linked"} mono />
                {session?.pushName ? <Row label="WhatsApp name" value={session.pushName} /> : null}
              </dl>
            ) : (
              <div className="space-y-2">
                {linkedNumber ? (
                  <p className="text-xs text-muted-foreground">
                    Last linked: <span className="font-mono">+{linkedNumber}</span> · not connected.
                  </p>
                ) : null}
                {session?.lastError ? <p className="text-xs text-muted-foreground">{session.lastError}</p> : null}
                <WhatsAppLinkQr onLinked={load} />
              </div>
            )}

            <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wa-dial">Default country code</Label>
                <Input
                  id="wa-dial"
                  value={dialCode}
                  onChange={(e) => setDialCode(e.target.value)}
                  placeholder={suggestedDialCode ? `${suggestedDialCode} (from ${data?.meta.currency})` : "91"}
                  inputMode="numeric"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Applied to customer numbers stored without one. Getting this wrong sends to the
                  wrong country.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wa-pace">Seconds between messages</Label>
                <Input
                  id="wa-pace"
                  value={paceSeconds}
                  onChange={(e) => setPaceSeconds(e.target.value)}
                  placeholder="4"
                  inputMode="decimal"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Minimum 1. Slower is safer — sending too fast can get a number restricted.
                </p>
              </div>
            </div>

            <SafeSending
              capacity={state?.capacity ?? null}
              dailyLimit={dailyLimit}
              setDailyLimit={setDailyLimit}
              quietOn={quietOn}
              setQuietOn={setQuietOn}
              quietStart={quietStart}
              setQuietStart={setQuietStart}
              quietEnd={quietEnd}
              setQuietEnd={setQuietEnd}
              optOutFooter={optOutFooter}
              setOptOutFooter={setOptOutFooter}
            />
          </>
        )}
      </CardContent>

      {state?.available === false ? null : (
        <CardFooter className="gap-2 border-t pt-4">
          <Button size="sm" onClick={savePreferences} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save preferences
          </Button>
          {ready || linkedNumber ? (
            <Button variant="outline" size="sm" onClick={unlink} disabled={busy} className="gap-1.5">
              <Unplug className="size-4" />
              Unlink number
            </Button>
          ) : null}
        </CardFooter>
      )}
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-[11px]" : ""}>{value}</dd>
    </div>
  );
}

function clampHour(value: string, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

/**
 * Safe sending: the limits the engine's guard applies to marketing (campaigns
 * and flows) on this number. Order confirmations, checkout reminders and
 * replies are paced but never capped.
 */
function SafeSending(props: {
  capacity: Capacity | null;
  dailyLimit: string;
  setDailyLimit: (v: string) => void;
  quietOn: boolean;
  setQuietOn: (v: boolean) => void;
  quietStart: string;
  setQuietStart: (v: string) => void;
  quietEnd: string;
  setQuietEnd: (v: string) => void;
  optOutFooter: boolean;
  setOptOutFooter: (v: boolean) => void;
}) {
  const c = props.capacity;
  const used = c && c.dailyLimit > 0 ? Math.min(100, Math.round((c.sentToday / c.dailyLimit) * 100)) : 0;

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <p className="text-xs font-medium">Safe sending</p>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Campaigns and flows are sent slowly with natural gaps, a typing indicator and regular
        breaks, skip numbers not on WhatsApp, and stop at the limits below. Order confirmations,
        checkout reminders and replies are never held back.
      </p>

      {c ? (
        <div className="space-y-1.5 rounded-lg border p-3">
          <div className="flex items-center justify-between text-xs">
            <span>
              Marketing sent in the last 24h: <strong>{c.sentToday}</strong> / {c.dailyLimit}
            </span>
            <span className="text-muted-foreground">
              this hour {c.sentThisHour} / {c.hourlyLimit}
            </span>
          </div>
          <Progress value={used} />
          <p className="text-[11px] text-muted-foreground">
            {c.warmupDay !== null
              ? `Warm-up day ${c.warmupDay}: a newly linked number starts low and rises to your limit (${c.accountLimit}/day) over about a month.`
              : "Warm-up complete."}
            {c.inQuietHours ? " Quiet hours now — marketing resumes in the morning." : ""}
            {c.pausedUntil ? " Marketing paused after repeated failures; resumes shortly." : ""}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wa-daily">Marketing messages per day</Label>
          <Input
            id="wa-daily"
            value={props.dailyLimit}
            onChange={(e) => props.setDailyLimit(e.target.value)}
            placeholder="300"
            inputMode="numeric"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Your ceiling once warmed up. Lower is safer; 200–500 suits most numbers.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="wa-quiet">Quiet hours</Label>
            <Switch id="wa-quiet" checked={props.quietOn} onCheckedChange={props.setQuietOn} aria-label="Quiet hours" />
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Quiet hours start"
              value={props.quietStart}
              onChange={(e) => props.setQuietStart(e.target.value)}
              disabled={!props.quietOn}
              inputMode="numeric"
              className="w-16"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              aria-label="Quiet hours end"
              value={props.quietEnd}
              onChange={(e) => props.setQuietEnd(e.target.value)}
              disabled={!props.quietOn}
              inputMode="numeric"
              className="w-16"
            />
            <span className="text-xs text-muted-foreground">h</span>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            24-hour clock. No campaigns or flows go out in these hours.
          </p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">Add &ldquo;Reply STOP to unsubscribe&rdquo;</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Customers who reply STOP are unsubscribed automatically. An easy way out is what keeps
            people from reporting your number as spam.
          </p>
        </div>
        <Switch checked={props.optOutFooter} onCheckedChange={props.setOptOutFooter} aria-label="STOP footer" />
      </div>
    </div>
  );
}

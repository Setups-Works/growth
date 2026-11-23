"use client";

import { CheckCircle2, Loader2, MessageCircle, Save, TriangleAlert, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAnalytics } from "@/components/providers/analytics-provider";
import { WhatsAppLinkQr } from "@/components/whatsapp/whatsapp-link-qr";
import { dialCodeForCurrency } from "@/lib/whatsapp/phone";

interface Preferences {
  phone: string | null;
  defaultDialCode: string;
  delayBetweenMessagesMs: number;
  updatedAt: string | null;
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
  error?: string | null;
}

/**
 * Links this account's WhatsApp number as a linked device — the same as
 * WhatsApp Web: scan the QR from WhatsApp → Linked devices on the phone.
 * Campaigns, flows, reminders, the inbox and the menu bot all send through it.
 */
export function WhatsAppSettingsCard() {
  const [state, setState] = useState<SettingsResponse | null>(null);
  const [dialCode, setDialCode] = useState("");
  const [paceSeconds, setPaceSeconds] = useState("");
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
              WhatsApp Web. Campaigns, flows, reminders, the inbox and the menu bot all use it.
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

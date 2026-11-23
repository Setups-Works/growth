"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useBilling } from "@/components/providers/billing-provider";
import { adminSend, LoadState, Panel, useAdmin } from "./shared";

interface Settings {
  announcement: { enabled: boolean; message: string; tone: "info" | "warning" | "success"; link: string | null; linkLabel: string | null };
  signupsEnabled: boolean;
  supportEmail: string;
}

export function AdminSettings() {
  const { data, error, loading, reload } = useAdmin<{ settings: Settings; signupsLockedByEnv: boolean }>("/api/admin/settings");
  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? <Form key={JSON.stringify(data.settings)} initial={data.settings} signupsLocked={data.signupsLockedByEnv} onSaved={reload} /> : null}
    </LoadState>
  );
}

function Form({ initial, signupsLocked, onSaved }: { initial: Settings; signupsLocked: boolean; onSaved: () => void }) {
  const { refresh } = useBilling();
  const [a, setA] = useState(initial.announcement);
  const [signups, setSignups] = useState(initial.signupsEnabled);
  const [support, setSupport] = useState(initial.supportEmail);
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (section: string, body: Partial<Settings>) => {
    setSaving(section);
    const ok = await adminSend("/api/admin/settings", "PUT", body, "Saved.");
    setSaving(null);
    if (ok) {
      onSaved();
      refresh();
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Announcement banner" description="Shown at the top of every app page for every account: maintenance, new features, price changes.">
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">Show the banner</span>
            <Switch checked={a.enabled} onCheckedChange={(v) => setA({ ...a, enabled: v })} />
          </label>
          <div className="space-y-1.5">
            <Label className="text-xs">Message</Label>
            <Textarea value={a.message} onChange={(e) => setA({ ...a, message: e.target.value })} rows={3} maxLength={280} placeholder="Scheduled maintenance on Sunday 2–3 AM IST." />
            <p className="text-right text-[11px] text-ink-3">{a.message.length}/280</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Style</Label>
              <Select value={a.tone} onValueChange={(v) => setA({ ...a, tone: v as Settings["announcement"]["tone"] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="success">Good news</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Link (optional)</Label>
              <Input value={a.link ?? ""} onChange={(e) => setA({ ...a, link: e.target.value || null })} placeholder="/settings or https://…" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Link text</Label>
              <Input value={a.linkLabel ?? ""} onChange={(e) => setA({ ...a, linkLabel: e.target.value || null })} placeholder="Learn more" maxLength={40} />
            </div>
          </div>
          <Button type="button" disabled={saving !== null || (a.enabled && !a.message.trim())} onClick={() => save("announcement", { announcement: a })} className="gap-1.5">
            {saving === "announcement" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save banner
          </Button>
        </div>
      </Panel>

      <div className="space-y-6">
        <Panel title="Sign-ups" description="Turn off to stop new accounts being created. Existing accounts still sign in.">
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Allow new sign-ups</span>
              <Switch
                checked={signups && !signupsLocked}
                disabled={signupsLocked || saving !== null}
                onCheckedChange={(v) => {
                  setSignups(v);
                  void save("signups", { signupsEnabled: v });
                }}
              />
            </label>
            {signupsLocked ? <p className="text-xs text-ink-3">Closed by DISABLE_SIGNUPS=true in the server environment.</p> : null}
          </div>
        </Panel>

        <Panel title="Support email" description="Shown on the Billing panel as the place to ask about payments.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input type="email" value={support} onChange={(e) => setSupport(e.target.value)} placeholder="support@setups.works" />
            <Button type="button" disabled={saving !== null} onClick={() => save("support", { supportEmail: support.trim() })} className="gap-1.5">
              {saving === "support" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

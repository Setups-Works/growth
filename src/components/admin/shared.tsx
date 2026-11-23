"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** GETs an admin endpoint; `reload` re-fetches without blanking what's shown. */
export function useAdmin<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status}).`);
      setData(json as T);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/** Sends a change to an admin endpoint, toasting the outcome. Returns true on success. */
export async function adminSend(url: string, method: "POST" | "PUT" | "PATCH", body: unknown, success?: string) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status}).`);
    if (success) toast.success(success);
    return json as Record<string, unknown>;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Request failed.");
    return null;
  }
}

export function Panel({
  title,
  description,
  action,
  children,
  className,
  flush,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Content runs edge to edge (tables). */
  flush?: boolean;
}) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0 space-y-0.5">
          <CardTitle className="text-[14px]">{title}</CardTitle>
          {description ? <CardDescription className="text-[12.5px]">{description}</CardDescription> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className={cn(flush ? "p-0" : "px-4 py-4 sm:px-5")}>{children}</CardContent>
    </Card>
  );
}

export function ReloadButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={loading} className="gap-1.5">
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      Refresh
    </Button>
  );
}

export function LoadState({ error, loading, children }: { error: string | null; loading: boolean; children: ReactNode }) {
  if (error) {
    return <p className="rounded-lg border border-line px-4 py-6 text-center text-sm text-muted-foreground">{error}</p>;
  }
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return <>{children}</>;
}

/** A big number with a label, for the overview strip. */
export function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-card px-4 py-3.5">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-[22px] leading-tight font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-1 truncate text-[11.5px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

/** A table that scrolls sideways inside its card on a phone instead of widening the page. */
export function ScrollTable({ children }: { children: ReactNode }) {
  return <div className="w-full overflow-x-auto">{children}</div>;
}

export const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: paise % 100 ? 2 : 0 }).format(
    paise / 100,
  );

export const bytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-success/12 text-success",
  authenticated: "bg-data/12 text-data",
  past_due: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  created: "bg-hover text-ink-3",
  halted: "bg-destructive/12 text-destructive",
  cancelled: "bg-hover text-ink-3",
  none: "bg-hover text-ink-3",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  authenticated: "Trial",
  past_due: "Past due",
  created: "Awaiting mandate",
  halted: "Halted",
  cancelled: "Cancelled",
  none: "No plan",
};

export function StatusPill({ status }: { status: string | null | undefined }) {
  const s = status ?? "none";
  return (
    <span className={cn("inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", STATUS_TONE[s] ?? STATUS_TONE.none)}>
      {STATUS_LABEL[s] ?? s}
    </span>
  );
}

export function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "good" | "bad" | "info" | "warn" }) {
  const cls = {
    muted: "bg-hover text-ink-3",
    good: "bg-success/12 text-success",
    bad: "bg-destructive/12 text-destructive",
    info: "bg-data/12 text-data",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  }[tone];
  return <span className={cn("inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", cls)}>{children}</span>;
}

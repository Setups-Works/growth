"use client";

import { AlertTriangle, ArrowRight, Loader2, PlugZap, Store , Database } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FetchProgressPanel } from "@/components/dashboard/fetch-progress";
import { useAnalytics } from "@/components/providers/analytics-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsResult } from "@/lib/analytics/types";

/**
 * The gap between stacked sections. Page padding, width and the heading come
 * from PageFrame in the app layout, so every page gets them.
 */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

/**
 * Every analytics page renders through this: it owns the loading, error and
 * warning states so no page has to re-implement them, and it hands down a
 * guaranteed non-null result.
 */
export function AnalyticsPage({ children }: { children: (data: AnalyticsResult) => ReactNode }) {
  const { data, initialising, error, refresh, loading, notConnected, notSynced } =
    useAnalytics();

  if (initialising) return <LoadingState />;

  // No demo fallback by design: without a store there is nothing honest to show.
  if (notConnected) return <NotConnectedState />;

  /*
   * Connected, but the first pull has not run. Sending them to the sync screen
   * is the actual next step; the generic failure card offered "Try again",
   * which retries a read that cannot succeed until a sync happens.
   */
  if (notSynced) return <NotSyncedState />;

  if (error && !data) {
    return (
      <div>
        <Card className="mx-auto max-w-lg gap-4 p-6 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--critical)_14%,transparent)]">
            <PlugZap className="size-5 text-[var(--critical)]" />
          </div>
          <div className="space-y-1.5">
            <h2 className="font-semibold">Couldn&apos;t load analytics</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          <div className="flex justify-center gap-2">
            <Button onClick={refresh} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : null}
              Try again
            </Button>
            <Button asChild variant="outline">
              <Link href="/settings">Check connection</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return <LoadingState />;

  return (
    <PageShell>
      <ImportBanner onFinished={refresh} />

      {data.meta.warnings.length > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Partial data</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc space-y-0.5">
              {data.meta.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Showing the last successful load</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {children(data)}
    </PageShell>
  );
}

function NotConnectedState() {
  return (
    <div>
      <Card className="mx-auto max-w-lg gap-4 p-6 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted">
          <Store className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h2 className="font-semibold">Connect your WooCommerce store</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every figure in this dashboard is computed from your own orders, so there is nothing to show until a
            store is authorized. You will approve read-only access inside your own WordPress admin.
          </p>
        </div>
        <div className="flex justify-center">
          <Button asChild>
            <Link href="/settings">
              Authorize a store <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}

function NotSyncedState() {
  return (
    <div>
      <Card className="mx-auto max-w-lg gap-4 p-6 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted">
          <Database className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h2 className="font-semibold">Your store is still being copied</h2>
          <p className="text-sm text-muted-foreground">
            Orders are mirrored into the database so the dashboard reads them instantly. The first
            pull takes a few minutes.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button asChild>
            <Link href="/onboarding/sync">See progress</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings">Settings</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <FetchProgressPanel />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="gap-0 p-4">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-3 h-7 w-28" />
            <Skeleton className="mt-3 h-4 w-16" />
          </Card>
        ))}
      </div>
      <Card className="p-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-[260px] w-full" />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-[200px] w-full" />
        </Card>
        <Card className="p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-[200px] w-full" />
        </Card>
      </div>
    </div>
  );
}

/** Shown when a section genuinely has nothing to display, with a reason. */
export function EmptySection({
  title,
  description,
  action,
  icon: Icon = AlertTriangle,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: typeof AlertTriangle;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * Shown while a first sync is still importing order history, so partial
 * figures are never mistaken for complete ones. Checks every 15 seconds and
 * refreshes the analytics once the import finishes.
 */
function ImportBanner({ onFinished }: { onFinished: () => void }) {
  const [state, setState] = useState<{ backfillDone: boolean; orders: number; backfillThrough: string | null } | null>(null);
  // Read through a ref so a new callback identity never restarts the checks.
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    let stopped = false;
    let wasImporting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      try {
        const res = await fetch("/api/sync", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { backfillDone: boolean; orders: number; backfillThrough: string | null };
        if (stopped) return;
        setState(body);
        if (!body.backfillDone) {
          wasImporting = true;
          timer = setTimeout(() => void check(), 15_000);
        } else if (wasImporting) {
          finished.current();
        }
      } catch {
        /* the banner is informational; never break the page over it */
      }
    };
    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!state || state.backfillDone) return null;

  const through = state.backfillThrough
    ? new Date(state.backfillThrough).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : null;

  return (
    <Alert>
      <Loader2 className="animate-spin" />
      <AlertTitle>Still importing your order history</AlertTitle>
      <AlertDescription>
        <p>
          {state.orders.toLocaleString()} orders so far{through ? `, up to ${through}` : ""}. Figures are incomplete
          until the import finishes — usually a few minutes.{" "}
          <Link href="/onboarding/sync" className="underline underline-offset-2">
            Watch progress
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminSend, ago, LoadState, Panel, Pill, ReloadButton, ScrollTable, useAdmin } from "./shared";

interface StoreRow {
  id: string;
  url: string;
  name: string | null;
  user_id: string;
  email: string;
  is_active: boolean;
  order_count: number;
  customer_count: number;
  product_count: number;
  last_sync_at: string | null;
  backfill_done: boolean;
  abandoned_checkout_enabled: boolean;
  order_confirmation_enabled: boolean;
}

export function AdminStores({ openUser }: { openUser: (id: string) => void }) {
  const { data, error, loading, reload } = useAdmin<{ stores: StoreRow[]; syncing: string[] }>("/api/admin/stores");
  const [busy, setBusy] = useState<string | null>(null);

  const sync = async (s: StoreRow, action: "sync" | "full_resync") => {
    if (action === "full_resync" && !window.confirm(`Re-import the whole order history of ${s.url}? This can take a while on a big store.`)) return;
    setBusy(s.id);
    await adminSend("/api/admin/stores", "POST", { storeId: s.id, action }, "Sync started in the background.");
    setBusy(null);
    setTimeout(reload, 1500);
  };

  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? (
        <Panel
          title="Connected stores"
          description={`${data.stores.length} stores · scheduled syncs run every 10 minutes`}
          action={<ReloadButton loading={loading} onClick={reload} />}
          flush
        >
          <ScrollTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 sm:pl-5">Store</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Customers</TableHead>
                  <TableHead>Sync</TableHead>
                  <TableHead>Automations</TableHead>
                  <TableHead className="pr-4 text-right sm:pr-5">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.stores.map((s) => {
                  const running = data.syncing.includes(s.id);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="max-w-[240px] pl-4 sm:pl-5">
                        <a href={s.url} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline">
                          {s.name || s.url.replace(/^https?:\/\//, "")}
                        </a>
                        <span className="block truncate text-xs text-ink-3">{s.url}</span>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <button type="button" onClick={() => openUser(s.user_id)} className="truncate text-left text-sm text-data hover:underline">
                          {s.email}
                        </button>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.order_count.toLocaleString("en-IN")}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.customer_count.toLocaleString("en-IN")}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {running ? <Pill tone="info">syncing now</Pill> : s.backfill_done ? <span className="text-xs text-ink-3">{ago(s.last_sync_at)}</span> : <Pill tone="warn">importing</Pill>}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {s.order_confirmation_enabled ? <Pill tone="good">confirmations</Pill> : null}
                          {s.abandoned_checkout_enabled ? <Pill tone="good">checkouts</Pill> : null}
                          {!s.order_confirmation_enabled && !s.abandoned_checkout_enabled ? <span className="text-xs text-ink-3">—</span> : null}
                        </div>
                      </TableCell>
                      <TableCell className="pr-4 text-right sm:pr-5">
                        <div className="flex justify-end gap-1.5">
                          <Button type="button" size="sm" variant="outline" disabled={busy !== null || running} onClick={() => sync(s, "sync")} className="gap-1">
                            {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                            Sync
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy !== null || running} onClick={() => sync(s, "full_resync")}>
                            Full re-import
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {data.stores.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-sm text-ink-3">
                      No stores connected yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </ScrollTable>
        </Panel>
      ) : null}
    </LoadState>
  );
}

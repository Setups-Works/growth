"use client";

import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ago, LoadState, Panel, Pill, ScrollTable, StatusPill, useAdmin } from "./shared";

interface UserRow {
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
  legacy_unlimited: boolean | null;
  stores: number;
  orders: number;
  sent: number;
}

const FILTERS = [
  ["all", "All"],
  ["paying", "Paying"],
  ["trial", "Trial"],
  ["free", "No plan"],
  ["admins", "Admins"],
  ["suspended", "Suspended"],
] as const;

export function AdminUsers({ openUser, version }: { openUser: (id: string) => void; version: number }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const url = `/api/admin/users?q=${encodeURIComponent(debounced)}&filter=${filter}&page=${page}&v=${version}`;
  const { data, error, loading } = useAdmin<{ users: UserRow[]; total: number; page: number; pageSize: number }>(url);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email, name or phone" className="pl-8" aria-label="Search accounts" />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setFilter(id);
                setPage(1);
              }}
              className={cn(
                "rounded-lg px-2.5 py-1 text-[12.5px] transition-colors",
                filter === id ? "bg-primary text-primary-foreground" : "text-ink-3 hover:bg-hover hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Panel
        title="Accounts"
        description={data ? `${data.total.toLocaleString("en-IN")} matching` : undefined}
        flush
        action={
          pages > 1 ? (
            <div className="flex items-center gap-1 text-xs text-ink-3">
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                <ChevronLeft className="size-4" />
              </Button>
              {page} / {pages}
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null
        }
      >
        <LoadState error={error} loading={loading && !data}>
          <ScrollTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 sm:pl-5">Account</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Stores</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Msgs (month)</TableHead>
                  <TableHead className="pr-4 text-right sm:pr-5">Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.users.map((u) => (
                  <TableRow key={u.id} className="cursor-pointer" onClick={() => openUser(u.id)}>
                    <TableCell className="max-w-[280px] pl-4 sm:pl-5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{u.email}</span>
                        {u.is_admin || u.envAdmin ? <Pill tone="info">admin</Pill> : null}
                        {u.suspended_at ? <Pill tone="bad">suspended</Pill> : null}
                      </div>
                      {u.name || u.phone ? (
                        <p className="truncate text-xs text-ink-3">{[u.name, u.phone].filter(Boolean).join(" · ")}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm capitalize">{u.legacy_unlimited ? "Unlimited" : (u.plan ?? "—")}</span>
                        {u.plan && !u.legacy_unlimited ? <StatusPill status={u.subscription_status} /> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.stores}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.orders.toLocaleString("en-IN")}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.sent.toLocaleString("en-IN")}</TableCell>
                    <TableCell className="pr-4 text-right text-xs whitespace-nowrap text-ink-3 sm:pr-5">{ago(u.created_at)}</TableCell>
                  </TableRow>
                ))}
                {data && data.users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-ink-3">
                      No accounts match.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </ScrollTable>
        </LoadState>
      </Panel>
    </div>
  );
}

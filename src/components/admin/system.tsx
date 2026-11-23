"use client";

import { CircleCheck, CircleX } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ago, bytes, Kpi, LoadState, Panel, Pill, ReloadButton, ScrollTable, useAdmin, when } from "./shared";

interface SystemResponse {
  integrations: { name: string; ok: boolean; detail?: string }[];
  database: { bytes: number; tables: { name: string; bytes: number; rows: number; exact: boolean }[] };
  migrations: Record<string, unknown>[];
  process: { node: string; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number; startedAt: string };
  whatsapp: { id: string; email: string | null; status: string; phone: string | null; connectedAt: string | null; lastActive: string | null; lastError: string | null }[];
  audit: { id: number; admin_email: string; action: string; target: string | null; detail: Record<string, unknown>; created_at: string }[];
}

const uptime = (s: number) => (s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);

export function AdminWhatsApp({ openUser }: { openUser: (id: string) => void }) {
  const { data, error, loading, reload } = useAdmin<SystemResponse>("/api/admin/system");
  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? (
        <Panel
          title="Linked WhatsApp numbers"
          description="Every account's linked device on this server. Numbers are shown so you can help with support. Never message them from here."
          action={<ReloadButton loading={loading} onClick={reload} />}
          flush
        >
          <ScrollTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 sm:pl-5">Account</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead className="pr-4 sm:pr-5">Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.whatsapp.map((s) => (
                  <TableRow key={s.id} className="cursor-pointer" onClick={() => openUser(s.id)}>
                    <TableCell className="max-w-[220px] truncate pl-4 font-medium sm:pl-5">{s.email ?? s.id}</TableCell>
                    <TableCell className="tabular-nums">{s.phone ? `+${s.phone}` : "—"}</TableCell>
                    <TableCell>
                      <Pill tone={s.status === "ready" ? "good" : s.status === "qr_ready" || s.status === "initializing" ? "info" : "muted"}>{s.status}</Pill>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-ink-3">{s.connectedAt ? ago(s.connectedAt) : "—"}</TableCell>
                    <TableCell className="max-w-[260px] truncate pr-4 text-xs text-ink-3 sm:pr-5">{s.lastError ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {data.whatsapp.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-ink-3">
                      No WhatsApp numbers linked on this server.
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

export function AdminSystem() {
  const { data, error, loading, reload } = useAdmin<SystemResponse>("/api/admin/system");

  return (
    <LoadState error={error} loading={loading && !data}>
      {data ? (
        <div className="space-y-6">
          <div className="flex justify-end">
            <ReloadButton loading={loading} onClick={reload} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Database size" value={bytes(data.database.bytes)} />
            <Kpi label="Uptime" value={uptime(data.process.uptimeSeconds)} hint={`since ${when(data.process.startedAt)}`} />
            <Kpi label="Memory (RSS)" value={bytes(data.process.rssBytes)} hint={`heap ${bytes(data.process.heapUsedBytes)}`} />
            <Kpi label="Node.js" value={data.process.node} hint={`${data.migrations.length} migrations applied`} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Configuration" description="Whether each integration is set up. Secret values are never shown." flush>
              <ul className="divide-y divide-line">
                {data.integrations.map((i) => (
                  <li key={i.name} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                    <span className="flex min-w-0 items-center gap-2">
                      {i.ok ? <CircleCheck className="size-4 shrink-0 text-success" /> : <CircleX className="size-4 shrink-0 text-ink-4" />}
                      <span className="truncate">{i.name}</span>
                    </span>
                    <span className="truncate text-right text-xs text-ink-3">{i.detail ?? (i.ok ? "set" : "not set")}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Largest tables" flush>
              <ul className="divide-y divide-line">
                {data.database.tables.map((t) => (
                  <li key={t.name} className="flex items-center justify-between gap-3 px-4 py-2 text-sm sm:px-5">
                    <code className="truncate text-xs">{t.name}</code>
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">
                      {t.exact
                        ? `${t.rows.toLocaleString("en-IN")} ${t.rows === 1 ? "row" : "rows"} · `
                        : t.rows > 0
                          ? `~${Math.round(t.rows).toLocaleString("en-IN")} rows · `
                          : ""}
                      {bytes(t.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <Panel title="Admin audit log" description="Every change made from this panel, newest first." flush>
            <ScrollTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4 sm:pl-5">When</TableHead>
                    <TableHead>Admin</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="pr-4 sm:pr-5">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.audit.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="pl-4 text-xs whitespace-nowrap text-ink-3 sm:pl-5">{when(a.created_at)}</TableCell>
                      <TableCell className="max-w-[180px] truncate text-xs">{a.admin_email}</TableCell>
                      <TableCell>
                        <code className="text-xs">{a.action}</code>
                      </TableCell>
                      <TableCell className="max-w-[360px] truncate pr-4 text-xs text-ink-3 sm:pr-5">{summarise(a.detail)}</TableCell>
                    </TableRow>
                  ))}
                  {data.audit.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-sm text-ink-3">
                        No admin actions yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </ScrollTable>
          </Panel>
        </div>
      ) : null}
    </LoadState>
  );
}

function summarise(detail: Record<string, unknown>): string {
  const { action: _a, features: _f, ...rest } = detail;
  void _a;
  void _f;
  return Object.entries(rest)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

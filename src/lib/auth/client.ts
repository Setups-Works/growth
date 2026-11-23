"use client";

/** Browser-side helpers for the /api/auth/* routes. */

export const MIN_PASSWORD = 8;

/** POSTs JSON and throws the server's `error` message on a non-2xx answer. */
export async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status}).`);
  return data;
}

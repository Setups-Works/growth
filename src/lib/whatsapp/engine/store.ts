import { db } from "@/lib/db/client";

/**
 * The engine's tables (db/migrations/0002_whatsapp_engine.sql): a send log,
 * and per-account plugin configuration (the menu bot). Every function takes
 * the account's session id — its user id — explicitly.
 *
 * WhatsApp messages themselves are never stored. Incoming messages are read
 * once (for opt-outs and the menu bot) and dropped; for each message the
 * account sends, only a content-free row is kept — no text, no recipient —
 * because the safe-sending guard counts recent sends to enforce its caps.
 * Rows older than SEND_LOG_KEEP are pruned as new ones arrive.
 */

/** The guard looks back one day; a little more covers clock edges. */
const SEND_LOG_KEEP = "2 days";

/** Records that the account sent one message of this kind. Content-free. */
export async function recordSend(sessionId: string, waMessageId: string, kind: string): Promise<void> {
  await db()`
    insert into wa_messages (session_id, wa_message_id, chat_id, from_me, type, body, "timestamp", status, kind)
    values (${sessionId}, ${waMessageId}, '', true, 'sent', '', ${Math.floor(Date.now() / 1000)}, 'sent', ${kind})
    on conflict (session_id, wa_message_id) do nothing
  `;
  await db()`
    delete from wa_messages
    where session_id = ${sessionId} and created_at < now() - ${SEND_LOG_KEEP}::interval
  `;
}

export async function readPlugin(
  sessionId: string,
  pluginId: string,
): Promise<{ config: Record<string, unknown>; enabled: boolean } | null> {
  const [row] = await db()<{ config: Record<string, unknown>; enabled: boolean }[]>`
    select config, enabled from wa_plugins
    where session_id = ${sessionId} and plugin_id = ${pluginId}
  `;
  return row ?? null;
}

export async function writePluginConfig(sessionId: string, pluginId: string, config: unknown): Promise<void> {
  await db()`
    insert into wa_plugins (session_id, plugin_id, config) values (${sessionId}, ${pluginId}, ${db().json(config as never)})
    on conflict (session_id, plugin_id) do update set config = excluded.config, updated_at = now()
  `;
}

export async function writePluginEnabled(sessionId: string, pluginId: string, enabled: boolean): Promise<void> {
  await db()`
    insert into wa_plugins (session_id, plugin_id, enabled) values (${sessionId}, ${pluginId}, ${enabled})
    on conflict (session_id, plugin_id) do update set enabled = excluded.enabled, updated_at = now()
  `;
}

export async function deleteSessionData(sessionId: string): Promise<void> {
  await db()`delete from wa_messages where session_id = ${sessionId}`;
  await db()`delete from wa_plugins where session_id = ${sessionId}`;
}

// ── Safe sending ────────────────────────────────────────────────────────────

/** Outgoing messages of one kind sent in the last `withinMs`. */
export async function countSent(sessionId: string, kind: string, withinMs: number): Promise<number> {
  const [row] = await db()<{ n: number }[]>`
    select count(*)::int as n from wa_messages
    where session_id = ${sessionId} and from_me and kind = ${kind}
      and created_at > now() - make_interval(secs => ${withinMs / 1000})
  `;
  return row?.n ?? 0;
}

export interface SendSettings {
  dailyLimit: number;
  quietStart: number | null;
  quietEnd: number | null;
  optOutFooter: boolean;
  delayMs: number;
  linkedAt: Date | null;
}

export async function readSendSettings(sessionId: string): Promise<SendSettings> {
  const [row] = await db()<
    {
      daily_limit: number;
      quiet_start: number | null;
      quiet_end: number | null;
      opt_out_footer: boolean;
      send_delay_ms: number;
      linked_at: Date | null;
    }[]
  >`
    select daily_limit, quiet_start, quiet_end, opt_out_footer, send_delay_ms, linked_at
    from whatsapp_connections where user_id::text = ${sessionId}
  `;
  return {
    dailyLimit: row?.daily_limit ?? 300,
    quietStart: row ? row.quiet_start : 21,
    quietEnd: row ? row.quiet_end : 9,
    optOutFooter: row?.opt_out_footer ?? true,
    delayMs: row?.send_delay_ms ?? 4000,
    linkedAt: row?.linked_at ?? null,
  };
}

/** Remembers when this number was first linked (the warm-up clock). */
export async function markLinked(sessionId: string, phone: string | null): Promise<void> {
  await db()`
    insert into whatsapp_connections (user_id, session_id, phone, linked_at)
    values (${sessionId}::uuid, ${sessionId}, ${phone}, now())
    on conflict (user_id) do update set
      linked_at = coalesce(whatsapp_connections.linked_at, now()),
      phone = coalesce(excluded.phone, whatsapp_connections.phone)
  `;
}

/** A device unlinked from the phone starts its warm-up again when relinked. */
export async function clearLinked(sessionId: string): Promise<void> {
  await db()`update whatsapp_connections set linked_at = null where user_id::text = ${sessionId}`;
}

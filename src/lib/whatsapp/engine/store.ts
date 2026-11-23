import { db } from "@/lib/db/client";
import type { WhatsAppChat, WhatsAppMessage } from "../client";

/**
 * The engine's tables (db/migrations/0002_whatsapp_engine.sql): the message
 * log behind the inbox, and per-account plugin configuration (the menu bot).
 * Every function takes the account's session id — its user id — explicitly.
 */

export interface StoredMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  sender: string | null;
  pushName: string | null;
  type: string;
  body: string;
  timestamp: number;
  status: string | null;
  /** For outgoing messages: 'marketing' | 'transactional' | 'reply'. */
  kind?: string | null;
}

export async function saveMessage(sessionId: string, m: StoredMessage): Promise<void> {
  await db()`
    insert into wa_messages (session_id, wa_message_id, chat_id, from_me, sender, push_name, type, body, "timestamp", status, kind)
    values (${sessionId}, ${m.id}, ${m.chatId}, ${m.fromMe}, ${m.sender}, ${m.pushName},
            ${m.type}, ${m.body}, ${m.timestamp}, ${m.status}, ${m.kind ?? null})
    on conflict (session_id, wa_message_id) do update set
      status = coalesce(excluded.status, wa_messages.status),
      kind = coalesce(excluded.kind, wa_messages.kind),
      body = case when excluded.body <> '' then excluded.body else wa_messages.body end
  `;
}

export async function updateStatus(sessionId: string, waMessageId: string, status: string): Promise<void> {
  await db()`
    update wa_messages set status = ${status}
    where session_id = ${sessionId} and wa_message_id = ${waMessageId}
  `;
}

/** Conversations, newest first, derived from the message log. */
export async function listChats(sessionId: string, limit: number): Promise<WhatsAppChat[]> {
  const rows = await db()<
    { chat_id: string; body: string; timestamp: string; type: string; push_name: string | null; unread: number }[]
  >`
    with latest as (
      select distinct on (chat_id) chat_id, body, "timestamp", type
      from wa_messages where session_id = ${sessionId}
      order by chat_id, "timestamp" desc
    ),
    last_out as (
      select chat_id, max("timestamp") as ts from wa_messages
      where session_id = ${sessionId} and from_me group by chat_id
    ),
    names as (
      select distinct on (chat_id) chat_id, push_name from wa_messages
      where session_id = ${sessionId} and not from_me and push_name is not null
      order by chat_id, "timestamp" desc
    )
    select l.chat_id, l.body, l."timestamp", l.type, n.push_name,
      (select count(*) from wa_messages m
        where m.session_id = ${sessionId} and m.chat_id = l.chat_id and not m.from_me
          and m."timestamp" > coalesce(o.ts, 0))::int as unread
    from latest l
    left join last_out o on o.chat_id = l.chat_id
    left join names n on n.chat_id = l.chat_id
    order by l."timestamp" desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.chat_id,
    name: r.push_name ?? null,
    isGroup: r.chat_id.endsWith("@g.us"),
    unreadCount: r.unread,
    timestamp: Number(r.timestamp),
    lastMessage: r.body || (r.type !== "text" ? `[${r.type}]` : ""),
  }));
}

/** One conversation's messages, oldest first (the order the inbox renders). */
export async function listMessages(sessionId: string, chatId: string, limit: number): Promise<WhatsAppMessage[]> {
  const rows = await db()<
    {
      wa_message_id: string;
      chat_id: string;
      from_me: boolean;
      sender: string | null;
      body: string;
      type: string;
      timestamp: string;
      status: string | null;
      created_at: Date;
    }[]
  >`
    select * from (
      select * from wa_messages
      where session_id = ${sessionId} and chat_id = ${chatId}
      order by "timestamp" desc limit ${limit}
    ) recent order by "timestamp" asc
  `;
  return rows.map((r) => ({
    id: r.wa_message_id,
    waMessageId: r.wa_message_id,
    chatId: r.chat_id,
    from: r.from_me ? "me" : (r.sender ?? r.chat_id),
    to: r.from_me ? r.chat_id : "me",
    body: r.body,
    type: r.type,
    direction: r.from_me ? "outgoing" : "incoming",
    timestamp: Number(r.timestamp),
    status: r.status,
    createdAt: r.created_at.toISOString(),
  }));
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

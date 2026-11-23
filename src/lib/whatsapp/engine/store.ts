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
}

export async function saveMessage(sessionId: string, m: StoredMessage): Promise<void> {
  await db()`
    insert into wa_messages (session_id, wa_message_id, chat_id, from_me, sender, push_name, type, body, "timestamp", status)
    values (${sessionId}, ${m.id}, ${m.chatId}, ${m.fromMe}, ${m.sender}, ${m.pushName},
            ${m.type}, ${m.body}, ${m.timestamp}, ${m.status})
    on conflict (session_id, wa_message_id) do update set
      status = coalesce(excluded.status, wa_messages.status),
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

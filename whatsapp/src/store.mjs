/**
 * PostgreSQL access for the engine: the message log behind the inbox, and
 * per-session plugin configuration. Tables are created by the app's
 * migrations (db/migrations/0002_whatsapp_engine.sql).
 */
import postgres from "postgres";

let sql = null;

export function db() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  sql = postgres(url, { max: 5, idle_timeout: 300, onnotice: () => {} });
  return sql;
}

export async function saveMessage(sessionId, m) {
  await db()`
    insert into wa_messages (session_id, wa_message_id, chat_id, from_me, sender, push_name, type, body, "timestamp", status)
    values (${sessionId}, ${m.id}, ${m.chatId}, ${m.fromMe}, ${m.sender ?? null}, ${m.pushName ?? null},
            ${m.type}, ${m.body}, ${m.timestamp}, ${m.status ?? null})
    on conflict (session_id, wa_message_id) do update set
      status = coalesce(excluded.status, wa_messages.status),
      body = case when excluded.body <> '' then excluded.body else wa_messages.body end
  `;
}

export async function saveMessages(sessionId, list) {
  for (const m of list) {
    try {
      await saveMessage(sessionId, m);
    } catch (error) {
      console.error(`[store] could not save message ${m.id}:`, error.message);
    }
  }
}

export async function updateStatus(sessionId, waMessageId, status) {
  await db()`
    update wa_messages set status = ${status}
    where session_id = ${sessionId} and wa_message_id = ${waMessageId}
  `;
}

/** Conversations, newest first, derived from the message log. */
export async function listChats(sessionId, limit) {
  const rows = await db()`
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
export async function listMessages(sessionId, chatId, limit) {
  const rows = await db()`
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

export async function readPlugin(sessionId, pluginId) {
  const [row] = await db()`
    select config, enabled, updated_at from wa_plugins
    where session_id = ${sessionId} and plugin_id = ${pluginId}
  `;
  return row ?? null;
}

export async function writePluginConfig(sessionId, pluginId, config) {
  await db()`
    insert into wa_plugins (session_id, plugin_id, config) values (${sessionId}, ${pluginId}, ${db().json(config)})
    on conflict (session_id, plugin_id) do update set config = excluded.config, updated_at = now()
  `;
}

export async function writePluginEnabled(sessionId, pluginId, enabled) {
  await db()`
    insert into wa_plugins (session_id, plugin_id, enabled) values (${sessionId}, ${pluginId}, ${enabled})
    on conflict (session_id, plugin_id) do update set enabled = excluded.enabled, updated_at = now()
  `;
}

export async function deleteSessionData(sessionId) {
  await db()`delete from wa_messages where session_id = ${sessionId}`;
  await db()`delete from wa_plugins where session_id = ${sessionId}`;
}

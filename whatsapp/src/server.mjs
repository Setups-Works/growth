/**
 * Setups Works Growth WhatsApp engine — HTTP API.
 *
 * Internal only: reachable on the Docker network by the app, authenticated
 * with a shared key (X-API-Key = WHATSAPP_ENGINE_KEY). Endpoint shapes match
 * what src/lib/whatsapp/client.ts in the app expects.
 *
 *   GET    /health
 *   GET    /api/sessions
 *   GET    /api/sessions/:id
 *   POST   /api/sessions/:id/start
 *   POST   /api/sessions/:id/stop
 *   POST   /api/sessions/:id/logout
 *   GET    /api/sessions/:id/qr
 *   GET    /api/sessions/:id/chats?limit=
 *   GET    /api/sessions/:id/messages?chatId=&limit=
 *   GET    /api/sessions/:id/contacts/check/:number
 *   POST   /api/sessions/:id/messages/send-text      { chatId, text }
 *   POST   /api/sessions/:id/messages/send-image     { chatId, url, caption }
 *   POST   /api/sessions/:id/messages/send-video     { chatId, url, caption }
 *   POST   /api/sessions/:id/messages/send-bulk      { messages, options, batchId? }
 *   GET    /api/sessions/:id/messages/batch/:batchId
 *   POST   /api/sessions/:id/messages/batch/:batchId/cancel
 *   GET    /api/sessions/:id/plugins/:pluginId
 *   PUT    /api/sessions/:id/plugins/:pluginId/config { config }
 *   POST   /api/sessions/:id/plugins/:pluginId/enable | /disable
 */
import { timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { Session } from "./session.mjs";
import { PLUGIN_ID } from "./menu-bot.mjs";
import * as store from "./store.mjs";

const PORT = Number(process.env.PORT ?? 3001);
const KEY = process.env.WHATSAPP_ENGINE_KEY ?? "";
const DATA_DIR = process.env.WA_DATA_DIR ?? "/data/sessions";
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

if (KEY.length < 16) {
  console.error("WHATSAPP_ENGINE_KEY must be set (16+ characters).");
  process.exit(1);
}

/** @type {Map<string, Session>} */
const sessions = new Map();

async function session(id, create = true) {
  let s = sessions.get(id);
  if (!s && create) {
    s = new Session(id);
    await s.loadIdentity();
    if (s.hasCredentials()) s.status = "disconnected";
    sessions.set(id, s);
  }
  return s ?? null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorised(req) {
  const given = Buffer.from(String(req.headers["x-api-key"] ?? ""));
  const expected = Buffer.from(KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, "Body too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function route(req, res) {
  const url = new URL(req.url, "http://engine");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, sessions: sessions.size });
  }
  if (!authorised(req)) throw new HttpError(401, "Invalid API key");

  if (parts[0] !== "api" || parts[1] !== "sessions") throw new HttpError(404, "Not found");

  if (parts.length === 2 && method === "GET") {
    return send(res, 200, [...sessions.values()].map((s) => s.toJSON()));
  }

  const id = parts[2];
  if (!SESSION_ID.test(id ?? "")) throw new HttpError(400, "Invalid session id.");
  const rest = parts.slice(3).join("/");
  const s = await session(id);

  // ── lifecycle ──
  if (rest === "" && method === "GET") return send(res, 200, s.toJSON());
  if (rest === "start" && method === "POST") {
    await s.start();
    return send(res, 200, s.toJSON());
  }
  if (rest === "stop" && method === "POST") {
    await s.stop();
    return send(res, 200, s.toJSON());
  }
  if (rest === "logout" && method === "POST") {
    await s.logout();
    sessions.delete(id);
    return send(res, 200, { loggedOut: true });
  }
  if (rest === "qr" && method === "GET") {
    if (!s.qr) throw new HttpError(400, s.status === "ready" ? "Session is already authenticated." : "No QR code is being offered.");
    return send(res, 200, { qrCode: s.qr, status: s.status });
  }

  // ── inbox ──
  if (rest === "chats" && method === "GET") {
    const limit = clamp(url.searchParams.get("limit"), 1, 200, 50);
    return send(res, 200, await store.listChats(id, limit));
  }
  if (rest === "messages" && method === "GET") {
    const chatId = url.searchParams.get("chatId");
    if (!chatId) throw new HttpError(400, "chatId is required.");
    const limit = clamp(url.searchParams.get("limit"), 1, 500, 50);
    return send(res, 200, { messages: await store.listMessages(id, chatId, limit) });
  }
  if (parts[3] === "contacts" && parts[4] === "check" && parts[5] && method === "GET") {
    return send(res, 200, await s.checkNumber(parts[5]));
  }

  // ── sending ──
  if (parts[3] === "messages" && method === "POST") {
    const action = parts.slice(4).join("/");
    if (action === "send-text") {
      const { chatId, text } = await readJson(req);
      if (!chatId || typeof text !== "string" || !text) throw new HttpError(400, "chatId and text are required.");
      return send(res, 201, await s.sendText(chatId, text));
    }
    if (action === "send-image" || action === "send-video") {
      const { chatId, url: media, caption } = await readJson(req);
      if (!chatId || !media) throw new HttpError(400, "chatId and url are required.");
      const result = action === "send-image" ? await s.sendImage(chatId, media, caption) : await s.sendVideo(chatId, media, caption);
      return send(res, 201, result);
    }
    if (action === "send-bulk") {
      const { messages, options, batchId } = await readJson(req);
      if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, "messages must be a non-empty array.");
      if (messages.length > 100) throw new HttpError(400, "At most 100 messages per batch.");
      return send(res, 202, s.sendBulk(messages, options, batchId));
    }
    if (parts[4] === "batch" && parts[5] && parts[6] === "cancel") {
      const batch = s.cancelBatch(parts[5]);
      if (!batch) throw new HttpError(404, "No such batch.");
      return send(res, 200, batch);
    }
  }
  if (parts[3] === "messages" && parts[4] === "batch" && parts[5] && method === "GET") {
    const batch = s.getBatch(parts[5]);
    if (!batch) throw new HttpError(404, "No such batch.");
    return send(res, 200, batch);
  }

  // ── plugins ──
  if (parts[3] === "plugins" && parts[4]) {
    const pluginId = parts[4];
    if (pluginId !== PLUGIN_ID) throw new HttpError(404, `Plugin "${pluginId}" is not available.`);
    const action = parts[5] ?? "";
    if (action === "" && method === "GET") {
      const row = await store.readPlugin(id, pluginId);
      return send(res, 200, {
        id: pluginId,
        status: row?.enabled ? "enabled" : "disabled",
        version: "builtin",
        config: row?.config ?? {},
      });
    }
    if (action === "config" && method === "PUT") {
      const { config } = await readJson(req);
      if (!config || typeof config !== "object") throw new HttpError(400, "config is required.");
      await store.writePluginConfig(id, pluginId, config);
      await s.reloadPlugins();
      return send(res, 200, { saved: true });
    }
    if ((action === "enable" || action === "disable") && method === "POST") {
      await store.writePluginEnabled(id, pluginId, action === "enable");
      await s.reloadPlugins();
      return send(res, 200, { status: action === "enable" ? "enabled" : "disabled" });
    }
  }

  throw new HttpError(404, "Not found");
}

function clamp(raw, min, max, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    send(res, status, { statusCode: status, message: error.message ?? "Internal error" });
  });
});

/** Reconnects every account that was linked before the engine restarted. */
async function restore() {
  let entries = [];
  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const s = await session(entry.name);
    if (s.hasCredentials()) {
      console.log(`[engine] restoring session ${entry.name}`);
      s.start().catch((e) => s.fail(e));
    }
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[engine] listening on :${PORT}`);
  void restore();
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    // Close sockets without logging out, so pairings survive the restart.
    for (const s of sessions.values()) {
      try {
        s.sock?.end(undefined);
      } catch {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

/**
 * One WhatsApp linked device per account.
 *
 * Built on Baileys (the WhatsApp Web multi-device protocol): the account owner
 * scans a QR in the app, exactly as with "Linked devices" on WhatsApp Web, and
 * this process holds the socket from then on. Pairing credentials are kept on
 * the engine's volume, so a restart reconnects the same number without a new
 * scan.
 *
 * Status values match what the app has always understood:
 *   created → initializing → qr_ready → ready, and disconnected.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import { MenuBot, PLUGIN_ID } from "./menu-bot.mjs";
import * as store from "./store.mjs";

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "warn" });
const DATA_DIR = process.env.WA_DATA_DIR ?? "/data/sessions";
/** WhatsApp offers a handful of QR codes per attempt; after that we stop until asked again. */
const MAX_QR_ROUNDS = 6;

let cachedVersion = null;
async function waVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  } catch {
    cachedVersion = undefined; // Baileys falls back to its bundled version.
  }
  return cachedVersion;
}

const STATUS_NAMES = { 0: "error", 1: "pending", 2: "sent", 3: "delivered", 4: "read", 5: "played" };

export class Session {
  constructor(id) {
    this.id = id;
    this.dir = join(DATA_DIR, id);
    this.sock = null;
    this.status = "created";
    this.qr = null;
    this.qrRounds = 0;
    this.phone = null;
    this.pushName = null;
    this.connectedAt = null;
    this.lastActive = null;
    this.lastError = null;
    this.stopping = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.menu = new MenuBot();
    this.menuConfig = null;
    this.batches = new Map();
    this.sendChain = Promise.resolve();
  }

  /** Whether this account has ever completed a pairing (credentials on disk). */
  hasCredentials() {
    return existsSync(join(this.dir, "creds.json"));
  }

  /** Reads the last-linked number from saved credentials, without connecting. */
  async loadIdentity() {
    try {
      const creds = JSON.parse(await readFile(join(this.dir, "creds.json"), "utf8"));
      if (creds?.me?.id) this.phone = creds.me.id.split(":")[0].split("@")[0];
      if (creds?.me?.name) this.pushName = creds.me.name;
      if (creds?.registered === false) this.phone = null;
    } catch {
      /* no credentials yet */
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.pushName ?? this.id,
      status: this.status,
      phone: this.phone,
      pushName: this.pushName,
      connectedAt: this.connectedAt,
      lastActive: this.lastActive,
      lastError: this.lastError,
      engineLoaded: this.sock !== null && this.status === "ready",
    };
  }

  async start() {
    if (this.sock) return; // already running (initializing, qr_ready or ready)
    clearTimeout(this.reconnectTimer);
    this.stopping = false;
    this.status = "initializing";
    this.lastError = null;
    this.qr = null;
    await this.reloadPlugins();

    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const sock = makeWASocket({
      version: await waVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.macOS("Setups Works Growth"),
      markOnlineOnConnect: false, // keep notifications on the owner's phone
      syncFullHistory: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => void this.onConnection(sock, update, state));
    sock.ev.on("messages.upsert", (event) => void this.onMessages(sock, event));
    sock.ev.on("messages.update", (updates) => void this.onMessageUpdates(updates));
    sock.ev.on("messaging-history.set", (event) => void this.onHistory(sock, event));
  }

  async onConnection(sock, update, state) {
    if (sock !== this.sock) return; // an old socket's late event

    if (update.qr) {
      this.qrRounds++;
      if (this.qrRounds > MAX_QR_ROUNDS) {
        // Nobody is scanning. Stop rather than offering codes forever; the app
        // starts a fresh attempt when the user opens the QR panel again.
        this.lastError = "QR code expired. Start linking again.";
        await this.stop();
        return;
      }
      this.qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 300 });
      this.status = "qr_ready";
    }

    if (update.connection === "open") {
      this.status = "ready";
      this.qr = null;
      this.qrRounds = 0;
      this.reconnectAttempts = 0;
      this.connectedAt = new Date().toISOString();
      this.lastActive = this.connectedAt;
      this.lastError = null;
      const me = sock.user;
      if (me?.id) this.phone = me.id.split(":")[0].split("@")[0];
      if (me?.name) this.pushName = me.name;
      console.log(`[session ${this.id}] connected as ${this.phone}`);
    }

    if (update.connection === "close") {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      this.sock = null;
      this.qr = null;

      if (this.stopping) {
        this.status = "disconnected";
        return;
      }

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        // Unlinked from the phone (or banned). The credentials are dead.
        console.log(`[session ${this.id}] logged out (${code})`);
        this.status = "disconnected";
        this.phone = null;
        this.lastError = "This device was unlinked from WhatsApp. Scan a new QR code to link again.";
        await rm(this.dir, { recursive: true, force: true }).catch(() => {});
        return;
      }

      const neverLinked = !state.creds.registered;
      if (neverLinked && code !== DisconnectReason.restartRequired) {
        // A pairing attempt that ended without a scan.
        this.status = "disconnected";
        this.lastError = this.lastError ?? "Linking was not completed. Start again to get a new QR code.";
        return;
      }

      // Transient (network, restart-after-pairing, replaced connection): reconnect.
      this.status = "initializing";
      const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 2000 * 2 ** this.reconnectAttempts++);
      this.lastError = code ? `Connection closed (${code}); reconnecting.` : null;
      this.reconnectTimer = setTimeout(() => void this.start().catch((e) => this.fail(e)), delay);
    }
  }

  fail(error) {
    console.error(`[session ${this.id}]`, error);
    this.sock = null;
    this.status = "disconnected";
    this.lastError = error?.message ?? String(error);
  }

  /** Stops the socket but keeps the pairing, so start() reconnects without a QR. */
  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = null;
    this.qr = null;
    this.qrRounds = 0;
    this.status = "disconnected";
    try {
      sock?.end(undefined);
    } catch {
      /* already closed */
    }
  }

  /** Unlinks the device from WhatsApp and forgets everything about it. */
  async logout() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    try {
      await this.sock?.logout();
    } catch {
      /* not connected — still wipe local state */
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* closed */
    }
    this.sock = null;
    this.status = "disconnected";
    this.phone = null;
    this.pushName = null;
    this.qr = null;
    this.menu.reset();
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    await store.deleteSessionData(this.id).catch(() => {});
  }

  // ── Addressing ──────────────────────────────────────────────────────────

  /** The app's chat id ("<digits>@c.us") → a Baileys JID. */
  toJid(chatId) {
    const value = String(chatId).trim();
    if (value.endsWith("@c.us")) return `${value.slice(0, -5)}@s.whatsapp.net`;
    if (value.includes("@")) return value;
    return `${value.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  /** A Baileys JID → the app's chat id, preferring phone-number form. */
  async toChatId(sock, jid, alt) {
    let value = jid;
    if (isLidUser(value)) {
      if (alt && isPnUser(alt)) value = alt;
      else {
        const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(value).catch(() => null);
        if (pn) value = pn;
      }
    }
    value = jidNormalizedUser(value);
    return value.endsWith("@s.whatsapp.net") ? `${value.slice(0, -15)}@c.us` : value;
  }

  // ── Inbound ─────────────────────────────────────────────────────────────

  async normalise(sock, msg) {
    const remote = msg.key?.remoteJid;
    if (!remote || remote === "status@broadcast" || !msg.message) return null;

    const { type, body } = describe(msg.message);
    if (!type) return null; // reactions, protocol messages, receipts

    const chatId = await this.toChatId(sock, remote, msg.key.remoteJidAlt);
    const participant = msg.key.participant
      ? await this.toChatId(sock, msg.key.participant, msg.key.participantAlt)
      : null;
    const ts = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000));

    return {
      id: msg.key.id,
      chatId,
      fromMe: Boolean(msg.key.fromMe),
      sender: msg.key.fromMe ? null : (participant ?? chatId),
      pushName: msg.key.fromMe ? null : (msg.pushName ?? null),
      type,
      body,
      timestamp: ts,
      status: msg.key.fromMe ? (STATUS_NAMES[msg.status] ?? "sent") : null,
      isGroup: Boolean(isJidGroup(remote)),
      replyJid: remote,
    };
  }

  async onMessages(sock, { messages, type }) {
    for (const msg of messages) {
      const m = await this.normalise(sock, msg);
      if (!m) continue;
      this.lastActive = new Date().toISOString();
      await store.saveMessage(this.id, m).catch((e) => console.error("[store]", e.message));

      if (type === "notify" && !m.fromMe && m.type === "text") {
        await this.runMenuBot(m).catch((e) => console.error(`[menu ${this.id}]`, e.message));
      }
    }
  }

  async onMessageUpdates(updates) {
    for (const { key, update } of updates) {
      if (key?.id && typeof update?.status === "number" && STATUS_NAMES[update.status]) {
        await store.updateStatus(this.id, key.id, STATUS_NAMES[update.status]).catch(() => {});
      }
    }
  }

  async onHistory(sock, { messages }) {
    // Recent history only, so the inbox has context without importing years.
    const recent = messages.slice(-2000);
    const list = [];
    for (const msg of recent) {
      const m = await this.normalise(sock, msg);
      if (m) list.push(m);
    }
    await store.saveMessages(this.id, list);
  }

  async reloadPlugins() {
    const row = await store.readPlugin(this.id, PLUGIN_ID).catch(() => null);
    this.menuConfig = row?.enabled ? row.config : null;
    this.menu.reset();
  }

  async runMenuBot(m) {
    if (!this.menuConfig) return;
    const text = this.menu.reply(this.menuConfig, m.chatId, m.body, m.isGroup);
    if (!text) return;
    // Replies to the JID the message came from, which may be a LID.
    await this.deliver(m.replyJid, { text });
  }

  // ── Outbound ────────────────────────────────────────────────────────────

  requireReady() {
    if (!this.sock || this.status !== "ready") {
      const error = new Error("Session is not active. Link WhatsApp in Settings first.");
      error.status = 409;
      throw error;
    }
  }

  async deliver(jid, content) {
    this.requireReady();
    const sent = await this.sock.sendMessage(jid, content);
    this.lastActive = new Date().toISOString();
    if (sent) {
      const m = await this.normalise(this.sock, sent);
      if (m) await store.saveMessage(this.id, m).catch(() => {});
    }
    return {
      messageId: sent?.key?.id ?? null,
      timestamp: Number(sent?.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    };
  }

  sendText(chatId, text) {
    return this.deliver(this.toJid(chatId), { text: String(text ?? "") });
  }

  sendImage(chatId, url, caption) {
    return this.deliver(this.toJid(chatId), { image: { url }, caption: caption || undefined });
  }

  sendVideo(chatId, url, caption) {
    return this.deliver(this.toJid(chatId), { video: { url }, caption: caption || undefined });
  }

  async checkNumber(number) {
    this.requireReady();
    const digits = String(number).replace(/\D/g, "");
    const [result] = (await this.sock.onWhatsApp(digits)) ?? [];
    return {
      number: digits,
      exists: Boolean(result?.exists),
      whatsappId: result?.exists ? await this.toChatId(this.sock, result.jid) : null,
    };
  }

  /**
   * Accepts a batch and works through it in the background, one message at a
   * time with the requested pacing. Batches on the same session queue behind
   * each other, so two broadcasts never interleave sends.
   */
  sendBulk(messages, options = {}, batchId) {
    this.requireReady();
    const id = batchId || `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const batch = {
      batchId: id,
      status: "queued",
      total: messages.length,
      sent: 0,
      failed: 0,
      cancelled: false,
      results: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.batches.set(id, batch);
    if (this.batches.size > 200) this.batches.delete(this.batches.keys().next().value);

    const delay = Math.max(1000, Number(options.delayBetweenMessages) || 4000);
    const jitter = options.randomizeDelay !== false;

    this.sendChain = this.sendChain.then(async () => {
      batch.status = "processing";
      for (let i = 0; i < messages.length; i++) {
        if (batch.cancelled) break;
        const item = messages[i];
        try {
          const result = await this.sendBulkItem(item);
          batch.sent++;
          batch.results.push({ chatId: item.chatId, success: true, messageId: result.messageId });
        } catch (error) {
          batch.failed++;
          batch.results.push({ chatId: item.chatId, success: false, error: error.message });
          if (options.stopOnError) break;
        }
        if (i < messages.length - 1 && !batch.cancelled) {
          await sleep(delay + (jitter ? Math.random() * 2000 : 0));
        }
      }
      batch.status = batch.cancelled ? "cancelled" : "completed";
      batch.completedAt = new Date().toISOString();
    });

    return { batchId: id, status: batch.status, total: batch.total };
  }

  sendBulkItem(item) {
    const content = item.content ?? {};
    const caption = content.caption ?? content.text;
    switch (item.type) {
      case "image":
        return this.sendImage(item.chatId, content.image?.url ?? content.url, caption);
      case "video":
        return this.sendVideo(item.chatId, content.video?.url ?? content.url, caption);
      default:
        return this.sendText(item.chatId, content.text ?? "");
    }
  }

  getBatch(id) {
    const batch = this.batches.get(id);
    if (!batch) return null;
    const { cancelled: _cancelled, ...rest } = batch;
    return { ...rest, pending: batch.total - batch.sent - batch.failed };
  }

  cancelBatch(id) {
    const batch = this.batches.get(id);
    if (!batch) return null;
    batch.cancelled = true;
    return this.getBatch(id);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The message's kind and its readable text, or a null type for non-messages. */
function describe(message) {
  const m = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  if (m.conversation) return { type: "text", body: m.conversation };
  if (m.extendedTextMessage) return { type: "text", body: m.extendedTextMessage.text ?? "" };
  if (m.imageMessage) return { type: "image", body: m.imageMessage.caption ?? "" };
  if (m.videoMessage) return { type: "video", body: m.videoMessage.caption ?? "" };
  if (m.audioMessage) return { type: "audio", body: "" };
  if (m.documentMessage) return { type: "document", body: m.documentMessage.fileName ?? m.documentMessage.caption ?? "" };
  if (m.documentWithCaptionMessage?.message?.documentMessage) {
    const d = m.documentWithCaptionMessage.message.documentMessage;
    return { type: "document", body: d.caption ?? d.fileName ?? "" };
  }
  if (m.stickerMessage) return { type: "sticker", body: "" };
  if (m.locationMessage) return { type: "location", body: m.locationMessage.name ?? m.locationMessage.address ?? "" };
  if (m.contactMessage) return { type: "contact", body: m.contactMessage.displayName ?? "" };
  if (m.buttonsResponseMessage) return { type: "text", body: m.buttonsResponseMessage.selectedDisplayText ?? "" };
  if (m.listResponseMessage) return { type: "text", body: m.listResponseMessage.title ?? "" };
  if (m.templateButtonReplyMessage) return { type: "text", body: m.templateButtonReplyMessage.selectedDisplayText ?? "" };
  return { type: null, body: "" };
}

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
  // Aliased: a plain function, not a React hook, despite the `use` prefix.
  useMultiFileAuthState as multiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import type { BulkMessageItem, BulkOptions, WhatsAppSession } from "../client";
import type { MenuConfig } from "../menu";
import { addOptOut, isOptedOut, removeOptOut } from "../opt-out";
import { WhatsAppApiError } from "./errors";
import { OPT_OUT_FOOTER, optOutIntent, SendGuard, spin, type SendKind } from "./guard";
import { MenuBot } from "./menu-bot";
import * as store from "./store";

/**
 * One WhatsApp linked device per account, held inside this Next.js server.
 *
 * Built on Baileys (the WhatsApp Web multi-device protocol): the account owner
 * scans a QR in Settings, exactly as with "Linked devices" on WhatsApp Web, and
 * this process holds the socket from then on. Pairing credentials live under
 * WHATSAPP_DATA_DIR (a Docker volume in production), so a restart reconnects
 * the same number without a new scan.
 *
 * Status values: created → initializing → qr_ready → ready, and disconnected.
 */

export const MENU_PLUGIN_ID = "chat-flow";
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "warn" });
/** WhatsApp offers a handful of QR codes per attempt; after that we stop until asked again. */
const MAX_QR_ROUNDS = 6;
const STATUS_NAMES: Record<number, string> = { 0: "error", 1: "pending", 2: "sent", 3: "delivered", 4: "read", 5: "played" };

export function dataDir(): string {
  return process.env.WHATSAPP_DATA_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), ".data", "whatsapp");
}

let cachedVersion: [number, number, number] | undefined | null = null;
async function waVersion(): Promise<[number, number, number] | undefined> {
  if (cachedVersion !== null) return cachedVersion;
  try {
    cachedVersion = (await fetchLatestBaileysVersion()).version;
  } catch {
    cachedVersion = undefined; // Baileys falls back to its bundled version.
  }
  return cachedVersion;
}

interface Batch {
  batchId: string;
  status: "queued" | "processing" | "completed" | "cancelled";
  total: number;
  sent: number;
  failed: number;
  cancelled: boolean;
  results: { chatId: string; success: boolean; messageId?: string | null; error?: string }[];
  createdAt: string;
  completedAt: string | null;
}

/** An incoming or outgoing message, read once and never stored. */
interface Normalised {
  id: string;
  chatId: string;
  fromMe: boolean;
  sender: string | null;
  pushName: string | null;
  type: string;
  body: string;
  timestamp: number;
  status: string | null;
  isGroup: boolean;
  replyJid: string;
}

export class Session {
  readonly dir: string;
  sock: WASocket | null = null;
  status = "created";
  qr: string | null = null;
  private qrRounds = 0;
  phone: string | null = null;
  pushName: string | null = null;
  connectedAt: string | null = null;
  lastActive: string | null = null;
  lastError: string | null = null;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private menu = new MenuBot();
  private menuConfig: MenuConfig | null = null;
  private batches = new Map<string, Batch>();
  private sendChain: Promise<void> = Promise.resolve();
  /** Every outgoing message goes through this — see guard.ts. */
  readonly guard: SendGuard;
  /** jid → whether it is on WhatsApp, so a number is looked up once a week at most. */
  private onWhatsApp = new Map<string, { exists: boolean; at: number }>();

  constructor(readonly id: string) {
    this.guard = new SendGuard(id);
    this.dir = join(/*turbopackIgnore: true*/ dataDir(), id);
  }

  hasCredentials(): boolean {
    return existsSync(join(/*turbopackIgnore: true*/ this.dir, "creds.json"));
  }

  /** Reads the last-linked number from saved credentials, without connecting. */
  async loadIdentity(): Promise<void> {
    try {
      const creds = JSON.parse(await readFile(join(/*turbopackIgnore: true*/ this.dir, "creds.json"), "utf8"));
      if (creds?.me?.id && creds.registered !== false) this.phone = String(creds.me.id).split(":")[0].split("@")[0];
      if (creds?.me?.name) this.pushName = creds.me.name;
      if (this.hasCredentials()) this.status = "disconnected";
    } catch {
      /* no credentials yet */
    }
  }

  toJSON(): WhatsAppSession {
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

  async start(): Promise<void> {
    if (this.sock) return; // already running (initializing, qr_ready or ready)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopping = false;
    this.status = "initializing";
    this.lastError = null;
    this.qr = null;
    await this.reloadPlugins();

    const { state, saveCreds } = await multiFileAuthState(this.dir);
    const sock = makeWASocket({
      version: await waVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.macOS("Growth by Setups Works"),
      markOnlineOnConnect: false, // keep notifications on the owner's phone
      syncFullHistory: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => void this.onConnection(sock, update, () => Boolean(state.creds.registered)));
    sock.ev.on("messages.upsert", (event) => void this.onMessages(sock, event.messages, event.type));
  }

  private async onConnection(sock: WASocket, update: Partial<ConnectionState>, registered: () => boolean): Promise<void> {
    if (sock !== this.sock) return; // an old socket's late event

    if (update.qr) {
      this.qrRounds++;
      if (this.qrRounds > MAX_QR_ROUNDS) {
        // Nobody is scanning. Stop rather than offering codes forever.
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
      if (sock.user?.id) this.phone = sock.user.id.split(":")[0].split("@")[0];
      if (sock.user?.name) this.pushName = sock.user.name;
      await store.markLinked(this.id, this.phone).catch(() => {});
      this.guard.invalidate();
      console.log(`[whatsapp ${this.id}] connected`);
    }

    if (update.connection === "close") {
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      this.sock = null;
      this.qr = null;

      if (this.stopping) {
        this.status = "disconnected";
        return;
      }

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        // Unlinked from the phone (or banned). The credentials are dead.
        this.status = "disconnected";
        this.phone = null;
        this.lastError = "This device was unlinked from WhatsApp. Scan a new QR code to link again.";
        await store.clearLinked(this.id).catch(() => {});
        await rm(this.dir, { recursive: true, force: true }).catch(() => {});
        return;
      }

      if (!registered() && code !== DisconnectReason.restartRequired) {
        // A pairing attempt that ended without a scan.
        this.status = "disconnected";
        this.lastError = this.lastError ?? "Linking was not completed. Start again to get a new QR code.";
        return;
      }

      // Transient (network, restart-after-pairing, replaced connection): reconnect.
      this.status = "initializing";
      const delay =
        code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 2000 * 2 ** this.reconnectAttempts++);
      this.lastError = code ? `Connection closed (${code}); reconnecting.` : null;
      this.reconnectTimer = setTimeout(() => void this.start().catch((e) => this.fail(e)), delay);
    }
  }

  fail(error: unknown): void {
    console.error(`[whatsapp ${this.id}]`, error);
    this.sock = null;
    this.status = "disconnected";
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  /** Stops the socket but keeps the pairing, so start() reconnects without a QR. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
  async logout(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
  toJid(chatId: string): string {
    const value = String(chatId).trim();
    if (value.endsWith("@c.us")) return `${value.slice(0, -5)}@s.whatsapp.net`;
    if (value.includes("@")) return value;
    return `${value.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  /** A Baileys JID → the app's chat id, preferring phone-number form over LID. */
  private async toChatId(sock: WASocket | null, jid: string, alt?: string | null): Promise<string> {
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

  private async normalise(sock: WASocket | null, msg: WAMessage): Promise<Normalised | null> {
    const remote = msg.key?.remoteJid;
    if (!remote || remote === "status@broadcast" || !msg.message || !msg.key.id) return null;

    const { type, body } = describe(msg.message);
    if (!type) return null; // reactions, protocol messages, receipts

    const chatId = await this.toChatId(sock, remote, msg.key.remoteJidAlt);
    const participant = msg.key.participant
      ? await this.toChatId(sock, msg.key.participant, msg.key.participantAlt)
      : null;
    const fromMe = Boolean(msg.key.fromMe);

    return {
      id: msg.key.id,
      chatId,
      fromMe,
      sender: fromMe ? null : (participant ?? chatId),
      pushName: fromMe ? null : (msg.pushName ?? null),
      type,
      body,
      timestamp: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      status: fromMe ? (STATUS_NAMES[msg.status ?? 2] ?? "sent") : null,
      isGroup: Boolean(isJidGroup(remote)),
      replyJid: remote,
    };
  }

  private async onMessages(sock: WASocket, messages: WAMessage[], type: string): Promise<void> {
    for (const msg of messages) {
      const m = await this.normalise(sock, msg);
      if (!m) continue;
      this.lastActive = new Date().toISOString();
      // Not stored: an incoming message is only checked for an opt-out and
      // handed to the menu bot, then dropped.

      if (type === "notify" && !m.fromMe && m.type === "text") {
        const handled = await this.handleOptOut(m).catch((e) => {
          console.error(`[whatsapp opt-out ${this.id}]`, e.message);
          return false;
        });
        if (!handled) {
          await this.runMenuBot(m).catch((e) => console.error(`[whatsapp menu ${this.id}]`, e.message));
        }
      }
    }
  }

  async reloadPlugins(): Promise<void> {
    const row = await store.readPlugin(this.id, MENU_PLUGIN_ID).catch(() => null);
    this.menuConfig = row?.enabled ? (row.config as unknown as MenuConfig) : null;
    this.menu.reset();
  }

  private async runMenuBot(m: Normalised): Promise<void> {
    if (!this.menuConfig) return;
    const text = this.menu.reply(this.menuConfig, m.chatId, m.body, m.isGroup);
    if (!text) return;
    // Replies to the JID the message came from, which may be a LID.
    await this.deliver(m.replyJid, { text }, "reply");
  }

  /**
   * "STOP" adds the customer to the opt-out list; "START" removes them. Being
   * able to unsubscribe in one word is what keeps people from reporting the
   * number as spam instead — the single biggest cause of bans.
   */
  private async handleOptOut(m: Normalised): Promise<boolean> {
    if (m.isGroup || !m.chatId.endsWith("@c.us")) return false;
    const intent = optOutIntent(m.body);
    if (!intent) return false;
    const digits = m.chatId.split("@")[0];
    if (intent === "stop") {
      await addOptOut(this.id, digits, "Replied STOP on WhatsApp");
      await this.deliver(m.replyJid, { text: "You're unsubscribed and won't get any more messages from us. Reply START to subscribe again." }, "reply");
    } else {
      await removeOptOut(this.id, digits);
      await this.deliver(m.replyJid, { text: "Welcome back! You're subscribed again. Reply STOP any time to unsubscribe." }, "reply");
    }
    return true;
  }

  // ── Outbound ────────────────────────────────────────────────────────────

  private requireReady(endpoint: string): WASocket {
    if (!this.sock || this.status !== "ready") {
      throw new WhatsAppApiError("Session is not active. Link WhatsApp in Settings first.", 409, endpoint);
    }
    return this.sock;
  }

  /** Queues a message behind the guard, then sends it. */
  private deliver(
    jid: string,
    content: Parameters<WASocket["sendMessage"]>[1],
    kind: SendKind,
    waitIfBlocked = false,
  ) {
    this.requireReady("send");
    return this.guard.run(kind, () => this.sendNow(jid, content, kind), waitIfBlocked);
  }

  private async sendNow(jid: string, content: Parameters<WASocket["sendMessage"]>[1], kind: SendKind) {
    const sock = this.requireReady("send");

    if (kind !== "reply" && jid.endsWith("@s.whatsapp.net")) {
      const digits = jid.split("@")[0];
      // Opted out means no outreach of any kind — enforced here as well as by
      // each feature, so nothing can route around it.
      if (await isOptedOut(this.id, digits)) {
        throw new WhatsAppApiError("This customer replied STOP and has opted out.", 403, "send");
      }
      // Messaging numbers that aren't on WhatsApp is a strong spam signal.
      if (!(await this.isOnWhatsApp(sock, jid))) {
        throw new WhatsAppApiError("This number is not on WhatsApp.", 404, "send");
      }
    }

    await this.simulateTyping(sock, jid, content, kind);
    const sent = await sock.sendMessage(jid, content);
    this.lastActive = new Date().toISOString();
    // Content-free: the guard only needs to count recent sends.
    if (sent?.key?.id) await store.recordSend(this.id, sent.key.id, kind).catch(() => {});
    return {
      messageId: sent?.key?.id ?? "",
      timestamp: Number(sent?.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    };
  }

  private async isOnWhatsApp(sock: WASocket, jid: string): Promise<boolean> {
    const cached = this.onWhatsApp.get(jid);
    if (cached && Date.now() - cached.at < 7 * 24 * 60 * 60 * 1000) return cached.exists;
    const [result] = (await sock.onWhatsApp(jid.split("@")[0])) ?? [];
    const exists = Boolean(result?.exists);
    this.onWhatsApp.set(jid, { exists, at: Date.now() });
    if (this.onWhatsApp.size > 20_000) this.onWhatsApp.clear();
    return exists;
  }

  /** Shows "typing…" for about as long as a person would take to type it. */
  private async simulateTyping(sock: WASocket, jid: string, content: unknown, kind: SendKind): Promise<void> {
    const c = content as { text?: string; caption?: string };
    const length = (c.text ?? c.caption ?? "").length;
    const ms = kind === "reply" ? randBetween(600, 1500) : Math.min(6000, Math.max(1200, 800 + length * 35));
    try {
      await sock.sendPresenceUpdate("composing", jid);
      await sleep(ms);
      await sock.sendPresenceUpdate("paused", jid);
    } catch {
      /* presence is cosmetic; never block a send on it */
    }
  }

  /** Marketing text: `{a|b}` variations resolved, and the STOP footer added. */
  private async marketingText(text: string | undefined): Promise<string | undefined> {
    if (text === undefined) return undefined;
    let out = spin(text);
    const settings = await this.guard.readSettings();
    if (settings.optOutFooter && !/\bSTOP\b/.test(out)) out = `${out}\n\n${OPT_OUT_FOOTER}`;
    return out;
  }

  async sendText(chatId: string, text: string, kind: SendKind = "transactional", waitIfBlocked = false) {
    const body = kind === "marketing" ? ((await this.marketingText(text)) ?? "") : text;
    return this.deliver(this.toJid(chatId), { text: body }, kind, waitIfBlocked);
  }

  async sendImage(chatId: string, url: string, caption?: string, kind: SendKind = "transactional", waitIfBlocked = false) {
    const text = kind === "marketing" ? await this.marketingText(caption) : caption;
    return this.deliver(this.toJid(chatId), { image: { url }, caption: text || undefined }, kind, waitIfBlocked);
  }

  async sendVideo(chatId: string, url: string, caption?: string, kind: SendKind = "transactional", waitIfBlocked = false) {
    const text = kind === "marketing" ? await this.marketingText(caption) : caption;
    return this.deliver(this.toJid(chatId), { video: { url }, caption: text || undefined }, kind, waitIfBlocked);
  }

  /** Safe-sending limits and what is left right now. */
  capacity() {
    return this.guard.capacity();
  }

  async checkNumber(number: string) {
    const sock = this.requireReady("contacts/check");
    const digits = String(number).replace(/\D/g, "");
    const [result] = (await sock.onWhatsApp(digits)) ?? [];
    return {
      number: digits,
      exists: Boolean(result?.exists),
      whatsappId: result?.exists ? await this.toChatId(sock, result.jid) : null,
    };
  }

  /**
   * Accepts a batch and works through it in the background. Every message is
   * marketing and goes through the guard, which does the pacing, breaks,
   * limits and quiet hours; batches run one after another.
   */
  sendBulk(messages: BulkMessageItem[], options: BulkOptions = {}, batchId?: string) {
    this.requireReady("send-bulk");
    if (messages.length === 0) throw new WhatsAppApiError("messages must be a non-empty array.", 400, "send-bulk");
    if (messages.length > 100) throw new WhatsAppApiError("At most 100 messages per batch.", 400, "send-bulk");

    const id = batchId || `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const batch: Batch = {
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
    if (this.batches.size > 200) {
      const oldest = this.batches.keys().next().value;
      if (oldest) this.batches.delete(oldest);
    }

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
          batch.results.push({ chatId: item.chatId, success: false, error: (error as Error).message });
          if (options.stopOnError) break;
        }
      }
      batch.status = batch.cancelled ? "cancelled" : "completed";
      batch.completedAt = new Date().toISOString();
    });

    return { batchId: id, status: batch.status, total: batch.total };
  }

  private sendBulkItem(item: BulkMessageItem) {
    const content = item.content as {
      text?: string;
      caption?: string;
      url?: string;
      image?: { url?: string };
      video?: { url?: string };
    };
    const caption = content.caption ?? content.text;
    if (item.type === "image") {
      return this.sendImage(item.chatId, content.image?.url ?? content.url ?? "", caption, "marketing", true);
    }
    if (item.type === "video") {
      return this.sendVideo(item.chatId, content.video?.url ?? content.url ?? "", caption, "marketing", true);
    }
    return this.sendText(item.chatId, content.text ?? "", "marketing", true);
  }

  getBatch(id: string) {
    const batch = this.batches.get(id);
    if (!batch) return null;
    const { cancelled: _cancelled, ...rest } = batch;
    void _cancelled;
    return { ...rest, pending: batch.total - batch.sent - batch.failed };
  }

  cancelBatch(id: string) {
    const batch = this.batches.get(id);
    if (!batch) return null;
    batch.cancelled = true;
    return this.getBatch(id);
  }
}

function randBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MessageContent = NonNullable<WAMessage["message"]>;

/** The message's kind and its readable text, or a null type for non-messages. */
function describe(message: MessageContent): { type: string | null; body: string } {
  const m: MessageContent = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  if (m.conversation) return { type: "text", body: m.conversation };
  if (m.extendedTextMessage) return { type: "text", body: m.extendedTextMessage.text ?? "" };
  if (m.imageMessage) return { type: "image", body: m.imageMessage.caption ?? "" };
  if (m.videoMessage) return { type: "video", body: m.videoMessage.caption ?? "" };
  if (m.audioMessage) return { type: "audio", body: "" };
  if (m.documentMessage) return { type: "document", body: m.documentMessage.fileName ?? m.documentMessage.caption ?? "" };
  const docWithCaption = m.documentWithCaptionMessage?.message?.documentMessage;
  if (docWithCaption) return { type: "document", body: docWithCaption.caption ?? docWithCaption.fileName ?? "" };
  if (m.stickerMessage) return { type: "sticker", body: "" };
  if (m.locationMessage) return { type: "location", body: m.locationMessage.name ?? m.locationMessage.address ?? "" };
  if (m.contactMessage) return { type: "contact", body: m.contactMessage.displayName ?? "" };
  if (m.buttonsResponseMessage) return { type: "text", body: m.buttonsResponseMessage.selectedDisplayText ?? "" };
  if (m.listResponseMessage) return { type: "text", body: m.listResponseMessage.title ?? "" };
  if (m.templateButtonReplyMessage) {
    return { type: "text", body: m.templateButtonReplyMessage.selectedDisplayText ?? "" };
  }
  return { type: null, body: "" };
}

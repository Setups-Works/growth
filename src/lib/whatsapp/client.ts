import type { WhatsAppConfig } from "./config";
import { WhatsAppApiError } from "./engine/errors";

export { WhatsAppApiError };

/**
 * One account's WhatsApp, served by the engine running inside this Next.js
 * server (src/lib/whatsapp/engine). Every route goes through this class, so
 * the engine is only ever reached with the caller's own session id — the
 * account's user id.
 *
 * The engine is imported lazily: it pulls in the WhatsApp protocol library,
 * which must never reach a browser bundle or slow down routes that don't send.
 */

/** Session state. */
export interface WhatsAppSession {
  id: string;
  name: string;
  /** "created" | "initializing" | "qr_ready" | "ready" | "disconnected" | ... */
  status: string;
  phone: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastActive: string | null;
  lastError: string | null;
  engineLoaded: boolean;
}

/** A conversation, as listed by the engine. */
export interface WhatsAppChat {
  id: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
}

/** One stored message. */
export interface WhatsAppMessage {
  id: string;
  waMessageId: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  direction: "incoming" | "outgoing";
  timestamp: number;
  status: string | null;
  createdAt: string;
}

export interface NumberCheck {
  number: string;
  exists: boolean;
  whatsappId: string | null;
}

export interface SentMessage {
  messageId: string;
  timestamp: number;
}

export type BulkMessageType = "text" | "image" | "video" | "audio" | "document";

export interface BulkMessageItem {
  chatId: string;
  type: BulkMessageType;
  content: Record<string, unknown>;
}

export interface BulkOptions {
  /** The engine enforces a 1000ms floor. */
  delayBetweenMessages?: number;
  /** Adds 0-2s of jitter so sends do not land on a metronome. */
  randomizeDelay?: boolean;
  stopOnError?: boolean;
}

export interface BulkAccepted {
  batchId: string;
  [key: string]: unknown;
}

/**
 * A linked session reports this status — but the status alone does not mean
 * anything can be sent. See isSessionSendable.
 */
export const READY_STATUS = "ready";

/**
 * Whether the engine can actually deliver a message right now.
 *
 * `status` is a persisted database value and `engineLoaded` is the live one,
 * and they disagree after the engine process restarts: the row still says
 * "ready" while the in-memory engine is gone. A send in that state fails with
 * "Session is not active. Start the session first." for every recipient, so
 * both signals have to agree before anything is dispatched.
 */
export function isSessionSendable(session: {
  status: string;
  engineLoaded?: boolean;
}): boolean {
  return session.status === READY_STATUS && session.engineLoaded !== false;
}


export class WhatsAppClient {
  readonly sessionId: string;

  constructor(config: Pick<WhatsAppConfig, "sessionId">) {
    this.sessionId = config.sessionId;
  }

  private async session() {
    const { getSession } = await import("./engine");
    return getSession(this.sessionId);
  }

  /** Runs an engine call, turning unexpected failures into WhatsAppApiError. */
  private async call<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WhatsAppApiError) throw error;
      throw new WhatsAppApiError(error instanceof Error ? error.message : String(error), 502, endpoint);
    }
  }

  /** Connection state. */
  async getSession(): Promise<WhatsAppSession> {
    return (await this.session()).toJSON();
  }

  /** Open conversations, newest first. */
  listChats(limit = 50): Promise<WhatsAppChat[]> {
    return this.call("chats", async () => {
      const { listChats } = await import("./engine/store");
      return listChats(this.sessionId, Math.min(200, Math.max(1, limit)));
    });
  }

  /** Stored messages for one conversation, oldest first. */
  getMessages(chatId: string, limit = 50): Promise<WhatsAppMessage[]> {
    return this.call("messages", async () => {
      const { listMessages } = await import("./engine/store");
      return listMessages(this.sessionId, chatId, Math.min(500, Math.max(1, limit)));
    });
  }

  /** Gets the session running, whether or not it already was. Idempotent. */
  ensureStarted(): Promise<WhatsAppSession> {
    return this.call("start", async () => {
      const s = await this.session();
      await s.start();
      return s.toJSON();
    });
  }

  /** The pairing QR as a data URL, while one is being offered. */
  async getQr(): Promise<{ qrCode: string | null; status: string | null }> {
    const s = await this.session();
    return s.qr ? { qrCode: s.qr, status: s.status } : { qrCode: null, status: null };
  }

  /**
   * Returns a session that can actually send, reconnecting it if that is all
   * that is wrong.
   *
   * After a server restart the pairing is on disk but the socket may not be up
   * yet; starting it reconnects the same number in a few seconds with no QR.
   * A session that was never linked is returned unchanged: no amount of
   * restarting substitutes for a scan.
   */
  async ensureSendable(waitMs = 20_000): Promise<WhatsAppSession> {
    let session = await this.getSession();
    if (isSessionSendable(session)) return session;

    const recoverable =
      Boolean(session.phone) &&
      !session.engineLoaded &&
      ["ready", "disconnected", "initializing"].includes(session.status);
    if (!recoverable) return session;

    await this.ensureStarted().catch(() => {});

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      session = await this.getSession();
      if (isSessionSendable(session)) return session;
      // A dropped pairing surfaces as a QR offer; waiting cannot fix that.
      if (session.status === "qr_ready") break;
    }

    return session;
  }

  /**
   * Whether a number is registered on WhatsApp, and its canonical chat id.
   * Worth doing before a broadcast: sending to numbers that were never on
   * WhatsApp is both wasted and a pattern that attracts restrictions.
   */
  checkNumber(number: string): Promise<NumberCheck> {
    return this.call("contacts/check", async () => (await this.session()).checkNumber(number));
  }

  sendText(chatId: string, text: string): Promise<SentMessage> {
    return this.call("send-text", async () => (await this.session()).sendText(chatId, text));
  }

  sendImage(chatId: string, url: string, caption?: string): Promise<SentMessage> {
    return this.call("send-image", async () => (await this.session()).sendImage(chatId, url, caption));
  }

  sendVideo(chatId: string, url: string, caption?: string): Promise<SentMessage> {
    return this.call("send-video", async () => (await this.session()).sendVideo(chatId, url, caption));
  }

  /**
   * Hands a batch to the engine, which works through it in the background with
   * the requested pacing. Returns as soon as the batch is accepted.
   */
  sendBulk(messages: BulkMessageItem[], options: BulkOptions, batchId?: string): Promise<BulkAccepted> {
    return this.call("send-bulk", async () => (await this.session()).sendBulk(messages, options, batchId));
  }

  async getBatch(batchId: string): Promise<Record<string, unknown>> {
    const batch = (await this.session()).getBatch(batchId);
    if (!batch) throw new WhatsAppApiError("No such batch.", 404, "batch");
    return batch;
  }

  async cancelBatch(batchId: string): Promise<unknown> {
    const batch = (await this.session()).cancelBatch(batchId);
    if (!batch) throw new WhatsAppApiError("No such batch.", 404, "batch/cancel");
    return batch;
  }

  /** Unlinks the device from WhatsApp and deletes the session's local data. */
  async logout(): Promise<void> {
    const s = await this.session();
    await s.logout();
    const { dropSession } = await import("./engine");
    dropSession(this.sessionId);
  }

  // --- Plugins: per account. Today only the `chat-flow` menu bot. ----------

  async getPlugin(id: string): Promise<{
    id: string;
    status: string;
    version?: string;
    config?: Record<string, unknown>;
  }> {
    await this.requirePlugin(id);
    const { readPlugin } = await import("./engine/store");
    const row = await readPlugin(this.sessionId, id);
    return { id, status: row?.enabled ? "enabled" : "disabled", version: "builtin", config: row?.config ?? {} };
  }

  async setPluginConfig(id: string, config: unknown): Promise<unknown> {
    await this.requirePlugin(id);
    const { writePluginConfig } = await import("./engine/store");
    await writePluginConfig(this.sessionId, id, config);
    await (await this.session()).reloadPlugins();
    return { saved: true };
  }

  /** `enabled` false disables it. */
  async setPluginEnabled(id: string, enabled: boolean): Promise<unknown> {
    await this.requirePlugin(id);
    const { writePluginEnabled } = await import("./engine/store");
    await writePluginEnabled(this.sessionId, id, enabled);
    await (await this.session()).reloadPlugins();
    return { status: enabled ? "enabled" : "disabled" };
  }

  private async requirePlugin(id: string): Promise<void> {
    const { MENU_PLUGIN_ID } = await import("./engine/session");
    if (id !== MENU_PLUGIN_ID) throw new WhatsAppApiError(`Plugin "${id}" is not available.`, 404, "plugins");
  }
}

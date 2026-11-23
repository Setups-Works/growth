import { WhatsAppApiError } from "./errors";
import * as store from "./store";

/**
 * Safe sending: every outgoing message on one number goes through this guard.
 *
 * A linked device is not Meta's official API, so the number's safety depends
 * on looking like a person, not a script. What gets numbers restricted is
 * volume spikes, metronome-regular timing, identical text to many people,
 * messaging numbers that aren't on WhatsApp, night-time blasts, and being
 * reported as spam. This guard addresses the ones that are about *sending*:
 *
 *   - One queue per number. Nothing bursts: every feature (campaigns, flows,
 *     reminders, confirmations, replies) waits its turn.
 *   - Priority. Replies and transactional messages (order confirmations,
 *     checkout reminders) jump ahead of queued marketing, so a running
 *     campaign never delays a customer's order confirmation.
 *   - Human pacing. Random gaps between messages, and a longer break every
 *     15–25 marketing messages.
 *   - Marketing limits. Per rolling hour and 24 hours, with a warm-up
 *     schedule for newly linked numbers. Replies and transactional messages
 *     are paced but never capped — they answer something the customer did.
 *   - Quiet hours. Marketing waits outside them; nothing else does.
 *   - A brake. Several marketing failures in a row pause marketing for 30
 *     minutes instead of hammering on.
 *
 * The rest (typing indicator, skipping numbers not on WhatsApp, text
 * variation, the STOP footer and opt-outs) happens per message in session.ts.
 */

export type SendKind = "reply" | "transactional" | "marketing";

const PRIORITY: Record<SendKind, number> = { reply: 0, transactional: 1, marketing: 2 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TIMEZONE = process.env.WHATSAPP_TIMEZONE || "Asia/Kolkata";

/** Marketing messages per day allowed by how long the number has been linked. */
export function warmupLimit(daysLinked: number): number {
  if (daysLinked < 3) return 30;
  if (daysLinked < 7) return 80;
  if (daysLinked < 14) return 150;
  if (daysLinked < 30) return 300;
  return Number.POSITIVE_INFINITY;
}

export interface Capacity {
  /** Effective marketing limit per 24h (account limit, reduced during warm-up). */
  dailyLimit: number;
  accountLimit: number;
  warmupDay: number | null;
  sentToday: number;
  hourlyLimit: number;
  sentThisHour: number;
  /** Marketing messages that may go out right now. */
  remaining: number;
  quietHours: { start: number; end: number } | null;
  inQuietHours: boolean;
  pausedUntil: string | null;
  /** When marketing can next go out, if it can't now. */
  resumeAt: string | null;
}

interface Task {
  kind: SendKind;
  waitIfBlocked: boolean;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  notBefore: number;
}

export class SendGuard {
  private queue: Task[] = [];
  private pumping = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private marketingSinceBreak = 0;
  private nextBreakAfter = randInt(15, 25);
  private breakUntil = 0;
  private pausedUntil = 0;
  private consecutiveFailures = 0;
  private settings: store.SendSettings | null = null;
  private settingsReadAt = 0;

  constructor(private readonly sessionId: string) {}

  /**
   * Queues a send. `waitIfBlocked` is for background work (campaign batches):
   * the message waits through quiet hours, breaks and full limits. Without
   * it, a marketing message that cannot go out now is refused with 429, so a
   * scheduled job can record it and try again on its next run.
   */
  run<T>(kind: SendKind, send: () => Promise<T>, waitIfBlocked = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        kind,
        waitIfBlocked,
        run: send,
        resolve: resolve as (value: unknown) => void,
        reject,
        notBefore: 0,
      });
      void this.pump();
    });
  }

  /** Forgets cached settings, so a change in Settings applies to the next message. */
  invalidate(): void {
    this.settings = null;
  }

  async readSettings(): Promise<store.SendSettings> {
    if (!this.settings || Date.now() - this.settingsReadAt > 30_000) {
      this.settings = await store.readSendSettings(this.sessionId);
      this.settingsReadAt = Date.now();
    }
    return this.settings;
  }

  async capacity(): Promise<Capacity> {
    const settings = await this.readSettings();
    const now = Date.now();
    const daysLinked = settings.linkedAt ? Math.floor((now - settings.linkedAt.getTime()) / DAY) : 0;
    const warm = warmupLimit(daysLinked);
    const dailyLimit = Math.max(0, Math.min(settings.dailyLimit, warm));
    const hourlyLimit = Math.max(10, Math.ceil(dailyLimit / 6));
    const [sentToday, sentThisHour] = await Promise.all([
      store.countSent(this.sessionId, "marketing", DAY),
      store.countSent(this.sessionId, "marketing", HOUR),
    ]);
    const quiet = quietHours(settings);
    const inQuiet = quiet ? isQuietNow(quiet) : false;
    const paused = this.pausedUntil > now;
    const remaining = inQuiet || paused ? 0 : Math.max(0, Math.min(dailyLimit - sentToday, hourlyLimit - sentThisHour));

    let resumeAt: number | null = null;
    if (remaining === 0) {
      const candidates: number[] = [];
      if (paused) candidates.push(this.pausedUntil);
      if (inQuiet && quiet) candidates.push(nextQuietEnd(quiet));
      if (sentThisHour >= hourlyLimit) candidates.push(now + 10 * 60 * 1000);
      if (sentToday >= dailyLimit) candidates.push(now + 60 * 60 * 1000);
      resumeAt = candidates.length ? Math.max(...candidates) : null;
    }

    return {
      dailyLimit,
      accountLimit: settings.dailyLimit,
      warmupDay: Number.isFinite(warm) ? daysLinked + 1 : null,
      sentToday,
      hourlyLimit,
      sentThisHour,
      remaining,
      quietHours: quiet,
      inQuietHours: inQuiet,
      pausedUntil: paused ? new Date(this.pausedUntil).toISOString() : null,
      resumeAt: resumeAt ? new Date(resumeAt).toISOString() : null,
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;

    try {
      while (this.queue.length) {
        const now = Date.now();
        const task = this.pickNext(now);
        if (!task) {
          // Only marketing is waiting, and it is blocked for now.
          const wakeAt = Math.min(...this.queue.map((t) => Math.max(t.notBefore, this.breakUntil, this.pausedUntil)));
          this.schedule(Math.max(1000, Math.min(60_000, wakeAt - now)));
          return;
        }

        if (task.kind === "marketing") {
          const capacity = await this.capacity();
          if (capacity.remaining <= 0) {
            const reason = capacity.inQuietHours
              ? "Quiet hours: marketing messages wait until morning."
              : capacity.pausedUntil
                ? "Marketing is paused for 30 minutes after repeated send failures."
                : `This number's safe marketing limit is reached (${capacity.sentToday}/${capacity.dailyLimit} today, ${capacity.sentThisHour}/${capacity.hourlyLimit} this hour).`;
            if (task.waitIfBlocked) {
              task.notBefore = capacity.resumeAt ? Date.parse(capacity.resumeAt) : Date.now() + 60_000;
              this.queue.unshift(task);
              continue;
            }
            task.reject(new WhatsAppApiError(reason, 429, "send"));
            continue;
          }
        }

        // Human-ish spacing since the previous message, of any kind.
        const delayMs = task.kind === "marketing" ? (await this.readSettings()).delayMs : 0;
        const wait = this.lastSentAt + gapFor(task.kind, delayMs) - Date.now();
        if (wait > 0) await sleep(wait);

        try {
          task.resolve(await task.run());
          if (task.kind === "marketing") this.consecutiveFailures = 0;
        } catch (error) {
          task.reject(error);
          if (task.kind === "marketing" && !(error instanceof WhatsAppApiError && error.status === 404)) {
            // "Not on WhatsApp" is the guard working, not a failure signal.
            if (++this.consecutiveFailures >= 5) {
              this.pausedUntil = Date.now() + 30 * 60 * 1000;
              this.consecutiveFailures = 0;
              console.warn(`[whatsapp ${this.sessionId}] 5 marketing failures in a row; pausing marketing for 30 minutes`);
            }
          }
        }
        this.lastSentAt = Date.now();

        if (task.kind === "marketing" && ++this.marketingSinceBreak >= this.nextBreakAfter) {
          this.breakUntil = Date.now() + randInt(60, 180) * 1000;
          this.marketingSinceBreak = 0;
          this.nextBreakAfter = randInt(15, 25);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Highest-priority task that may go now; marketing waits out breaks and pauses. */
  private pickNext(now: number): Task | null {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const t = this.queue[i];
      const blocked =
        t.kind === "marketing" && (t.notBefore > now || this.breakUntil > now || this.pausedUntil > now);
      if (blocked) {
        if (!t.waitIfBlocked && this.pausedUntil > now) {
          // Direct marketing sends are refused rather than held during a pause.
          this.queue.splice(i--, 1);
          t.reject(new WhatsAppApiError("Marketing is paused for 30 minutes after repeated send failures.", 429, "send"));
        }
        continue;
      }
      if (best === -1 || PRIORITY[t.kind] < PRIORITY[this.queue[best].kind]) best = i;
    }
    return best === -1 ? null : this.queue.splice(best, 1)[0];
  }

  private schedule(ms: number): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => void this.pump(), ms);
  }
}

function gapFor(kind: SendKind, delayMs: number): number {
  if (kind === "reply") return randInt(1000, 2500);
  if (kind === "transactional") return randInt(3000, 6000);
  return Math.max(delayMs, 3000) + randInt(0, 3000);
}

function quietHours(s: store.SendSettings): { start: number; end: number } | null {
  if (s.quietStart === null || s.quietEnd === null || s.quietStart === s.quietEnd) return null;
  return { start: s.quietStart, end: s.quietEnd };
}

function localHour(date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: TIMEZONE }).format(date));
}

function isQuietNow(q: { start: number; end: number }): boolean {
  const h = localHour();
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

/** Roughly when quiet hours end — the next time the local hour equals `end`. */
function nextQuietEnd(q: { start: number; end: number }): number {
  const now = Date.now();
  for (let i = 1; i <= 24 * 4; i++) {
    const t = now + i * 15 * 60 * 1000;
    if (localHour(new Date(t)) === q.end) return t;
  }
  return now + HOUR;
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `{Hi|Hello|Hey}` → one of the options, picked at random per message. */
export function spin(text: string): string {
  return text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, options: string) => {
    const list = options.split("|");
    return list[Math.floor(Math.random() * list.length)];
  });
}

export const OPT_OUT_FOOTER = "Reply STOP to unsubscribe.";
const STOP_WORDS = new Set(["stop", "unsubscribe", "stop all", "opt out", "optout", "cancel"]);
const START_WORDS = new Set(["start", "subscribe", "unstop"]);

export function optOutIntent(text: string): "stop" | "start" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (STOP_WORDS.has(t)) return "stop";
  if (START_WORDS.has(t)) return "start";
  return null;
}

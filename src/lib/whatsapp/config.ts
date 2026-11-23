import { db } from "@/lib/db/client";

/**
 * WhatsApp for one account.
 *
 * WhatsApp runs inside this Next.js server: the engine (./engine) holds one
 * linked-device session per account, which the account owner links by
 * scanning a QR in Settings. There is nothing to configure — an account's
 * session id is simply its user id. Set WHATSAPP_DISABLED=true to turn
 * WhatsApp off for the whole deployment.
 *
 * What an account does configure is stored in `whatsapp_connections`, one row
 * per user: the default country code and the pace between sends.
 */
export interface WhatsAppConfig {
  /** This account's engine session — its user id. */
  sessionId: string;
  /** Number last linked, remembered for display. */
  phone?: string;
  /** Assumed when a customer's number carries no country code, e.g. "91". */
  defaultDialCode: string;
  /**
   * Pause between individual sends. The engine's floor is 1000ms; the default
   * is deliberately slower, because going too fast risks a restricted number.
   */
  delayBetweenMessagesMs: number;
  /** Safe sending (engine/guard.ts): marketing per 24h once warmed up. */
  dailyLimit: number;
  /** Local hours when marketing waits; null when quiet hours are off. */
  quietStart: number | null;
  quietEnd: number | null;
  /** Append "Reply STOP to unsubscribe" to marketing. */
  optOutFooter: boolean;
  updatedAt?: string;
}

export const DEFAULT_SEND_DELAY_MS = 4000;
/** The engine's own floor. */
export const MIN_SEND_DELAY_MS = 1000;
/** Recipients per submitted batch — the engine rejects more than this. */
export const MAX_BATCH_SIZE = 100;

/** True unless WhatsApp is switched off for this deployment. */
export function whatsappAvailable(): boolean {
  return process.env.WHATSAPP_DISABLED !== "true";
}

function envDialCode(): string {
  return (process.env.WHATSAPP_DIAL_CODE ?? "").replace(/\D/g, "");
}

function envDelay(): number {
  return Math.max(MIN_SEND_DELAY_MS, Number(process.env.WHATSAPP_SEND_DELAY_MS) || DEFAULT_SEND_DELAY_MS);
}

interface ConnectionRow {
  phone: string | null;
  dial_code: string | null;
  send_delay_ms: number | null;
  daily_limit: number | null;
  quiet_start: number | null;
  quiet_end: number | null;
  opt_out_footer: boolean | null;
  updated_at: Date | null;
}

/**
 * The account's WhatsApp configuration, or null when WhatsApp is disabled on
 * this deployment. Non-null does not mean a number is linked — check the session
 * (`isSessionSendable`) before sending.
 */
export async function readWhatsAppConfig(userId: string): Promise<WhatsAppConfig | null> {
  if (!whatsappAvailable()) return null;

  let row: ConnectionRow | undefined;
  try {
    [row] = await db()<ConnectionRow[]>`
      select phone, dial_code, send_delay_ms, daily_limit, quiet_start, quiet_end, opt_out_footer, updated_at
      from whatsapp_connections where user_id = ${userId}
    `;
  } catch {
    row = undefined;
  }

  return {
    sessionId: userId,
    phone: row?.phone ?? undefined,
    defaultDialCode: (row?.dial_code ?? "").replace(/\D/g, "") || envDialCode(),
    delayBetweenMessagesMs: Math.max(MIN_SEND_DELAY_MS, row?.send_delay_ms || envDelay()),
    dailyLimit: row?.daily_limit ?? 300,
    quietStart: row ? row.quiet_start : 21,
    quietEnd: row ? row.quiet_end : 9,
    optOutFooter: row?.opt_out_footer ?? true,
    updatedAt: row?.updated_at?.toISOString(),
  };
}

export interface WhatsAppPreferences {
  defaultDialCode?: string;
  delayBetweenMessagesMs?: number;
  phone?: string | null;
  /** Marketing messages per rolling 24h once warmed up. */
  dailyLimit?: number;
  /** Local hours when marketing waits; `null` start and end turns this off. */
  quietHours?: { start: number | null; end: number | null };
  /** Append "Reply STOP to unsubscribe" to marketing messages. */
  optOutFooter?: boolean;
}

/** Saves an account's sending preferences. Fields left undefined are unchanged. */
export async function writeWhatsAppPreferences(userId: string, prefs: WhatsAppPreferences): Promise<void> {
  const quietSet = prefs.quietHours !== undefined;
  await db()`
    insert into whatsapp_connections (user_id, session_id, dial_code, send_delay_ms, phone)
    values (
      ${userId}, ${userId},
      ${prefs.defaultDialCode ?? null},
      coalesce(${prefs.delayBetweenMessagesMs ?? null}::int, 4000),
      ${prefs.phone ?? null}
    )
    on conflict (user_id) do update set
      session_id    = excluded.session_id,
      dial_code     = coalesce(${prefs.defaultDialCode ?? null}, whatsapp_connections.dial_code),
      send_delay_ms = coalesce(${prefs.delayBetweenMessagesMs ?? null}::int, whatsapp_connections.send_delay_ms),
      phone         = coalesce(${prefs.phone ?? null}, whatsapp_connections.phone)
  `;
  await db()`
    update whatsapp_connections set
      daily_limit    = coalesce(${prefs.dailyLimit ?? null}::int, daily_limit),
      opt_out_footer = coalesce(${prefs.optOutFooter ?? null}::boolean, opt_out_footer),
      quiet_start    = case when ${quietSet} then ${prefs.quietHours?.start ?? null}::smallint else quiet_start end,
      quiet_end      = case when ${quietSet} then ${prefs.quietHours?.end ?? null}::smallint else quiet_end end,
      updated_at     = now()
    where user_id = ${userId}
  `;
}

export async function clearWhatsAppConfig(userId: string): Promise<void> {
  await db()`delete from whatsapp_connections where user_id = ${userId}`;
}

/** What the settings page may see. */
export function redactWhatsAppConfig(config: WhatsAppConfig | null) {
  if (!config) return null;
  return {
    phone: config.phone ?? null,
    defaultDialCode: config.defaultDialCode,
    delayBetweenMessagesMs: config.delayBetweenMessagesMs,
    dailyLimit: config.dailyLimit,
    quietStart: config.quietStart,
    quietEnd: config.quietEnd,
    optOutFooter: config.optOutFooter,
    updatedAt: config.updatedAt ?? null,
  };
}

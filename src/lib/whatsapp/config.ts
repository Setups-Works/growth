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
      select phone, dial_code, send_delay_ms, updated_at
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
    updatedAt: row?.updated_at?.toISOString(),
  };
}

/** Saves an account's sending preferences. */
export async function writeWhatsAppPreferences(
  userId: string,
  prefs: { defaultDialCode?: string; delayBetweenMessagesMs?: number; phone?: string | null },
): Promise<void> {
  await db()`
    insert into whatsapp_connections (user_id, session_id, dial_code, send_delay_ms, phone)
    values (
      ${userId}, ${userId},
      ${prefs.defaultDialCode ?? null},
      ${prefs.delayBetweenMessagesMs ?? null},
      ${prefs.phone ?? null}
    )
    on conflict (user_id) do update set
      session_id    = excluded.session_id,
      dial_code     = coalesce(excluded.dial_code, whatsapp_connections.dial_code),
      send_delay_ms = coalesce(excluded.send_delay_ms, whatsapp_connections.send_delay_ms),
      phone         = coalesce(excluded.phone, whatsapp_connections.phone)
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
    updatedAt: config.updatedAt ?? null,
  };
}

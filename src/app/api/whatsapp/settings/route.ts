import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/tenant";
import {
  clearWhatsAppConfig,
  MIN_SEND_DELAY_MS,
  readWhatsAppConfig,
  redactWhatsAppConfig,
  writeWhatsAppPreferences,
} from "@/lib/whatsapp/config";
import { isSessionSendable, WhatsAppApiError, WhatsAppClient } from "@/lib/whatsapp/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This account's WhatsApp: whether a number is linked, and its sending
 * preferences. Linking itself (the QR) is /api/whatsapp/session.
 */
export async function GET(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { userId } = resolved.value;

  const config = await readWhatsAppConfig(userId);
  if (!config) {
    return NextResponse.json({
      available: false,
      connected: false,
      config: null,
      session: null,
      error: "WhatsApp is turned off on this server (WHATSAPP_DISABLED=true).",
    });
  }

  let session = null;
  let error: string | null = null;
  try {
    session = await new WhatsAppClient(config).ensureSendable(8_000);
    // Remember the linked number so it can be shown even while disconnected.
    if (session.phone && session.phone !== config.phone) {
      await writeWhatsAppPreferences(userId, { phone: session.phone }).catch(() => {});
      config.phone = session.phone;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "The WhatsApp engine could not be reached.";
  }

  const ready = session ? isSessionSendable(session) : false;
  const capacity = await new WhatsAppClient(config).capacity().catch(() => null);
  return NextResponse.json({
    available: true,
    connected: ready,
    config: redactWhatsAppConfig(config),
    session,
    ready,
    capacity,
    error,
  });
}

const hour = z.number().int().min(0).max(23).nullable();

const schema = z.object({
  defaultDialCode: z.string().max(4).optional(),
  delayBetweenMessagesMs: z.coerce.number().int().min(MIN_SEND_DELAY_MS).max(60_000).optional(),
  /** Safe-sending limit for marketing per 24 hours, once warmed up. */
  dailyLimit: z.coerce.number().int().min(10).max(2000).optional(),
  /** Both null turns quiet hours off. */
  quietHours: z.object({ start: hour, end: hour }).optional(),
  optOutFooter: z.boolean().optional(),
});

/** Saves the default country code and sending pace. */
export async function PUT(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { userId } = resolved.value;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join(" ") }, { status: 422 });
  }

  await writeWhatsAppPreferences(userId, {
    defaultDialCode:
      parsed.data.defaultDialCode !== undefined ? parsed.data.defaultDialCode.replace(/\D/g, "") : undefined,
    delayBetweenMessagesMs: parsed.data.delayBetweenMessagesMs,
    dailyLimit: parsed.data.dailyLimit,
    quietHours: parsed.data.quietHours,
    optOutFooter: parsed.data.optOutFooter,
  });

  const config = await readWhatsAppConfig(userId);
  if (config) await new WhatsAppClient(config).reloadSettings().catch(() => {});
  return NextResponse.json({ saved: true, config: redactWhatsAppConfig(config) });
}

/**
 * Unlinks the WhatsApp number: logs the device out of WhatsApp (it disappears
 * from Linked devices on the phone) and deletes the session's local data.
 */
export async function DELETE(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;
  const { userId } = resolved.value;

  const config = await readWhatsAppConfig(userId);
  if (config) {
    try {
      await new WhatsAppClient(config).logout();
    } catch (err) {
      if (!(err instanceof WhatsAppApiError) || err.status === 0) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Could not reach the WhatsApp engine." },
          { status: 502 },
        );
      }
    }
  }

  await clearWhatsAppConfig(userId);
  return NextResponse.json({ connected: false, config: null, session: null });
}

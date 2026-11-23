import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/tenant";
import { isSessionSendable, WhatsAppApiError, WhatsAppClient } from "@/lib/whatsapp/client";
import { readWhatsAppConfig } from "@/lib/whatsapp/config";
import {
  EMPTY_MENU,
  MAX_MENU_DEPTH,
  PLUGIN_ID,
  depthOf,
  forGateway,
  renumber,
  type MenuConfig,
  type MenuOption,
} from "@/lib/whatsapp/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The inbound menu bot's configuration.
 *
 * A thin proxy to the WhatsApp engine's per-account `chat-flow` plugin, which
 * answers inbound messages (src/lib/whatsapp/engine/menu-bot.ts).
 */

/**
 * A menu option, to any depth.
 *
 * Zod needs the explicit annotation because the schema refers to itself; the
 * depth cap is enforced after parsing, where the error can say something useful
 * rather than "invalid input" from a recursion limit.
 */
const optionSchema: z.ZodType<MenuOption> = z.lazy(() =>
  z.object({
    key: z.string().min(1).max(8),
    text: z.string().max(4000),
    options: z.array(optionSchema).max(20).optional(),
  }),
);

const menuSchema = z.object({
  trigger: z.string().max(40),
  greeting: z.string().min(1, "The greeting cannot be empty.").max(4000),
  options: z.array(optionSchema).min(1, "A menu needs at least one option.").max(20),
  respondInGroups: z.boolean(),
  /** Sent separately from the config, because it is a different gateway call. */
  enabled: z.boolean().optional(),
});

async function client(userId: string): Promise<WhatsAppClient | null> {
  const config = await readWhatsAppConfig(userId);
  return config ? new WhatsAppClient(config) : null;
}

/** The current menu, and whether it is answering anyone. */
export async function GET(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;

  const gateway = await client(resolved.value.userId);
  if (!gateway) {
    return NextResponse.json(
      { error: "WhatsApp is not enabled on this server.", code: "gateway_not_connected" },
      { status: 409 },
    );
  }

  try {
    const [plugin, session] = await Promise.all([
      gateway.getPlugin(PLUGIN_ID),
      gateway.getSession().catch(() => null),
    ]);
    const raw = (plugin.config ?? {}) as Partial<MenuConfig>;

    /*
     * The gateway masks secret-looking values as "***" when it returns a
     * plugin's config. None of the menu fields are secret, but a masked value
     * would silently overwrite real text on the next save, so anything that
     * comes back masked is treated as absent.
     */
    const menu: MenuConfig = {
      trigger: unmask(raw.trigger) ?? EMPTY_MENU.trigger,
      greeting: unmask(raw.greeting) ?? "",
      options: Array.isArray(raw.options) ? raw.options : [],
      respondInGroups: raw.respondInGroups === true,
    };

    return NextResponse.json({
      menu,
      enabled: plugin.status === "enabled",
      // The menu bot is built into the engine; what can be missing is a linked
      // number for it to answer from.
      installed: session ? isSessionSendable(session) : false,
      version: plugin.version ?? null,
    });
  } catch (error) {
    if (error instanceof WhatsAppApiError && error.status === 404) {
      // Not installed is a normal state, not a failure: the menu bot is an
      // optional extension of the gateway.
      return NextResponse.json({ menu: EMPTY_MENU, enabled: false, installed: false });
    }
    return NextResponse.json({ error: describe(error) }, { status: 502 });
  }
}

/** Saves the menu, and turns it on or off. */
export async function PUT(request: Request) {
  const resolved = await requireTenant(request);
  if (!resolved.ok) return resolved.response;

  const gateway = await client(resolved.value.userId);
  if (!gateway) {
    return NextResponse.json(
      { error: "WhatsApp is not enabled on this server.", code: "gateway_not_connected" },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = menuSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(" ") },
      { status: 422 },
    );
  }

  const { enabled, ...menu } = parsed.data;

  if (depthOf(menu.options) > MAX_MENU_DEPTH) {
    return NextResponse.json(
      { error: `Menus can nest ${MAX_MENU_DEPTH} deep. Anything further is hard to follow on a phone.` },
      { status: 422 },
    );
  }

  try {
    // Renumbered server-side too: keys are what the customer types, and a menu
    // offering "1, 2, 4" is a bug the customer sees.
    await gateway.setPluginConfig(
      PLUGIN_ID,
      forGateway({ ...menu, options: renumber(menu.options) }),
    );

    if (typeof enabled === "boolean") {
      await gateway.setPluginEnabled(PLUGIN_ID, enabled);
    }

    return NextResponse.json({ saved: true, enabled: enabled ?? null });
  } catch (error) {
    return NextResponse.json({ error: describe(error) }, { status: 502 });
  }
}

function unmask(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\*+$/.test(value.trim()) ? null : value;
}

function describe(error: unknown): string {
  if (error instanceof WhatsAppApiError) return error.message;
  return error instanceof Error ? error.message : "The gateway did not respond.";
}

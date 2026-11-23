/**
 * The `chat-flow` menu bot, running inside the engine so it answers at any
 * hour whether or not the web app is up.
 *
 * Config shape (edited in the app's Menu screen, src/lib/whatsapp/menu.ts):
 *   { trigger, greeting, options: [{ key, text, options? }], respondInGroups }
 *
 * Behaviour:
 *   - A message that is exactly the trigger (case-insensitive) opens the menu
 *     and gets the greeting. An empty trigger matches any text message.
 *   - While a menu is open, a reply equal to one of the current options' keys
 *     gets that option's text. If the option has children, the conversation
 *     moves into that submenu; otherwise the menu closes.
 *   - Anything else is ignored and left for a person in the inbox.
 *   - Position is per conversation and expires after 15 minutes, so a stray
 *     "1" the next day is never read as a menu choice.
 */

export const PLUGIN_ID = "chat-flow";
const STATE_TTL_MS = 15 * 60 * 1000;

export class MenuBot {
  constructor() {
    /** chatId -> { path: number[], expires: number } */
    this.state = new Map();
  }

  /**
   * Decides the reply to an inbound text, or null for "not ours".
   * `config` is the saved plugin config; the caller checks it is enabled.
   */
  reply(config, chatId, text, isGroup) {
    if (!config || !Array.isArray(config.options) || !config.greeting) return null;
    if (isGroup && !config.respondInGroups) return null;

    const input = text.trim().toLowerCase();
    if (!input) return null;
    const now = Date.now();

    // Sweep expired conversations occasionally so the map can't grow forever.
    if (this.state.size > 5000) {
      for (const [k, v] of this.state) if (v.expires < now) this.state.delete(k);
    }

    const current = this.state.get(chatId);
    const active = current && current.expires > now ? current : null;

    // An option choice takes precedence over re-triggering, so a trigger of
    // "1" can't shadow the first option.
    if (active) {
      const list = optionsAt(config.options, active.path);
      const index = list.findIndex((o) => String(o.key).toLowerCase() === input);
      if (index !== -1) {
        const node = list[index];
        if (node.options?.length) {
          this.state.set(chatId, { path: [...active.path, index], expires: now + STATE_TTL_MS });
        } else {
          this.state.delete(chatId);
        }
        return node.text || null;
      }
    }

    const trigger = String(config.trigger ?? "").trim().toLowerCase();
    if (trigger ? input === trigger : !active) {
      this.state.set(chatId, { path: [], expires: now + STATE_TTL_MS });
      return config.greeting;
    }

    return null;
  }

  reset() {
    this.state.clear();
  }
}

function optionsAt(options, path) {
  let list = options;
  for (const i of path) {
    list = list[i]?.options ?? [];
  }
  return list;
}

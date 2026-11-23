import { readdir } from "node:fs/promises";
import { dataDir, Session } from "./session";

/**
 * The in-process WhatsApp engine: one Session per account, keyed by user id.
 *
 * Held on globalThis rather than in a module variable because Next.js may load
 * this module more than once in one server process (separate route bundles,
 * hot reload in development). Two copies would mean two sockets for the same
 * number, which WhatsApp treats as a conflict and disconnects.
 *
 * Runs only in a long-lived Node server (`next start` / the standalone
 * server.js in Docker). Run ONE app instance: sessions live in this process.
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/*
 * libsignal (inside Baileys) prints whole encryption sessions — private keys
 * included — with console.info("Closing session:", …) and friends. Those end
 * up in the host's log files, so they are dropped here before anything else
 * in the engine runs. Everything else logged through console.info is kept.
 */
const SIGNAL_SESSION_LOGS = ["Closing session", "Opening session", "Removing old closed session", "Migrating session to"];
const consoleFlag = globalThis as typeof globalThis & { __growthSignalLogFilter?: boolean };
if (!consoleFlag.__growthSignalLogFilter) {
  consoleFlag.__growthSignalLogFilter = true;
  const info = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    if (typeof args[0] === "string" && SIGNAL_SESSION_LOGS.some((p) => (args[0] as string).startsWith(p))) return;
    info(...args);
  };
}

type Registry = { sessions: Map<string, Session>; restored: boolean };
const g = globalThis as typeof globalThis & { __growthWhatsApp?: Registry };
const registry: Registry = (g.__growthWhatsApp ??= { sessions: new Map(), restored: false });

/** The account's session, created (not started) on first use. */
export async function getSession(id: string): Promise<Session> {
  if (!SESSION_ID.test(id)) throw new Error("Invalid WhatsApp session id.");
  let s = registry.sessions.get(id);
  if (!s) {
    s = new Session(id);
    registry.sessions.set(id, s);
    await s.loadIdentity();
  }
  return s;
}

/** Forgets a session after logout, so the next use starts clean. */
export function dropSession(id: string): void {
  registry.sessions.delete(id);
}

/**
 * Reconnects every account that was linked before the server restarted.
 * Called once at startup from src/instrumentation.ts.
 */
export async function restoreSessions(): Promise<void> {
  if (registry.restored) return;
  registry.restored = true;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dataDir(), { withFileTypes: true });
  } catch {
    return; // nothing linked yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const s = await getSession(entry.name);
    if (s.hasCredentials()) {
      console.log(`[whatsapp] restoring session ${entry.name}`);
      s.start().catch((e) => s.fail(e));
    }
  }
}

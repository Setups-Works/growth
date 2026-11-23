/**
 * Runs once when the Next.js server starts.
 *
 * - Reconnects every WhatsApp number that was linked before the restart, so
 *   campaigns, flows and the menu bot keep working without anyone opening the
 *   app. Not awaited: `register` must finish before the server accepts
 *   requests, and reconnecting can take a few seconds per account.
 * - Starts the built-in scheduler when INTERNAL_SCHEDULER=true (hosts with no
 *   separate cron container, such as Azure App Service).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.WHATSAPP_DISABLED !== "true") {
    const { restoreSessions } = await import("@/lib/whatsapp/engine");
    void restoreSessions().catch((error) => console.error("[whatsapp] restore failed:", error));
  }

  if (process.env.INTERNAL_SCHEDULER === "true") {
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}

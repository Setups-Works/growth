/**
 * Built-in scheduler, for hosts that run only the app (Azure App Service).
 *
 * Calls the same CRON_SECRET-protected routes, on the same schedule, as the
 * `cron` container in docker-compose.yml (docker/cron/crontab):
 *
 *   /api/cron/sync                  every 10 minutes
 *   /api/cron/abandoned-checkouts   every 5 minutes
 *   /api/cron/flows                 daily at 04:30 UTC
 *
 * Enabled with INTERNAL_SCHEDULER=true. Don't enable it alongside the cron
 * container, or every job runs twice. Runs in the app process, so it needs a
 * host that keeps the app running (App Service "Always On").
 */

interface Job {
  path: string;
  everyMs?: number;
  /** UTC hour and minute, for once-a-day jobs. */
  dailyAt?: { hour: number; minute: number };
}

const JOBS: Job[] = [
  { path: "/api/cron/sync", everyMs: 10 * 60_000 },
  { path: "/api/cron/abandoned-checkouts", everyMs: 5 * 60_000 },
  { path: "/api/cron/flows", dailyAt: { hour: 4, minute: 30 } },
];

const g = globalThis as typeof globalThis & { __growthScheduler?: boolean };

export function startScheduler(): void {
  if (g.__growthScheduler) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("[scheduler] CRON_SECRET is not set; built-in scheduler not started.");
    return;
  }
  g.__growthScheduler = true;

  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const running = new Set<string>();

  const run = async (job: Job) => {
    if (running.has(job.path)) return; // previous run still going
    running.add(job.path);
    try {
      const res = await fetch(`${base}${job.path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!res.ok) console.warn(`[scheduler] ${job.path} → HTTP ${res.status}`);
    } catch (error) {
      console.warn(`[scheduler] ${job.path} failed:`, error instanceof Error ? error.message : error);
    } finally {
      running.delete(job.path);
    }
  };

  // Give the server a minute to start listening before the first run.
  setTimeout(() => {
    for (const job of JOBS) {
      if (job.everyMs) {
        void run(job);
        setInterval(() => void run(job), job.everyMs);
      }
    }

    let lastDaily = "";
    setInterval(() => {
      const now = new Date();
      for (const job of JOBS) {
        if (!job.dailyAt) continue;
        const key = `${job.path}:${now.toISOString().slice(0, 10)}`;
        if (now.getUTCHours() === job.dailyAt.hour && now.getUTCMinutes() >= job.dailyAt.minute && lastDaily !== key) {
          lastDaily = key;
          void run(job);
        }
      }
    }, 30_000);

    console.log("[scheduler] built-in scheduler started");
  }, 60_000);
}

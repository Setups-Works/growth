import { db, databaseConfigured } from "@/lib/db/client";

/**
 * Site-wide settings an admin can change without a redeploy, stored in
 * `app_settings`. Small and typed: each key has a default, so a missing row
 * (a fresh database) behaves exactly like the default.
 */

export interface Announcement {
  enabled: boolean;
  message: string;
  tone: "info" | "warning" | "success";
  link: string | null;
  linkLabel: string | null;
}

export interface SiteSettings {
  announcement: Announcement;
  /** When false, /signup refuses new accounts (existing users still sign in). */
  signupsEnabled: boolean;
  /** Shown on the Billing panel and in emails as the place to get help. */
  supportEmail: string;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  announcement: { enabled: false, message: "", tone: "info", link: null, linkLabel: null },
  signupsEnabled: true,
  supportEmail: "",
};

const TTL_MS = 30_000;
const g = globalThis as typeof globalThis & { __growthSettings?: { at: number; value: SiteSettings } };

export async function getSettings(): Promise<SiteSettings> {
  const cached = g.__growthSettings;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (!databaseConfigured()) return DEFAULT_SETTINGS;
  try {
    const rows = await db()<{ key: string; value: unknown }[]>`select key, value from app_settings`;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const value: SiteSettings = {
      announcement: { ...DEFAULT_SETTINGS.announcement, ...((map.announcement as object) ?? {}) },
      signupsEnabled: typeof map.signupsEnabled === "boolean" ? map.signupsEnabled : DEFAULT_SETTINGS.signupsEnabled,
      supportEmail: typeof map.supportEmail === "string" ? map.supportEmail : DEFAULT_SETTINGS.supportEmail,
    };
    g.__growthSettings = { at: Date.now(), value };
    return value;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSetting<K extends keyof SiteSettings>(
  key: K,
  value: SiteSettings[K],
  updatedBy: string,
): Promise<void> {
  await db()`
    insert into app_settings (key, value, updated_by, updated_at)
    values (${key}, ${db().json(value as never)}, ${updatedBy}, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
  `;
  g.__growthSettings = undefined;
}

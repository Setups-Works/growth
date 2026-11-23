import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireAdmin } from "@/lib/auth/admin";
import { getSettings, saveSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: site-wide settings (announcement banner, sign-ups, support email). */
export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ settings: await getSettings(), signupsLockedByEnv: process.env.DISABLE_SIGNUPS === "true" });
}

const body = z.object({
  announcement: z
    .object({
      enabled: z.boolean(),
      message: z.string().trim().max(280),
      tone: z.enum(["info", "warning", "success"]),
      // In-app paths or https links only.
      link: z
        .string()
        .trim()
        .max(300)
        .regex(/^(\/(?!\/)|https:\/\/)/, "Links must start with / or https://")
        .nullable(),
      linkLabel: z.string().trim().max(40).nullable(),
    })
    .optional(),
  signupsEnabled: z.boolean().optional(),
  supportEmail: z.union([z.string().trim().email().max(200), z.literal("")]).optional(),
});

export async function PUT(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid settings." }, { status: 422 });
  }
  const s = parsed.data;
  if (s.announcement) await saveSetting("announcement", s.announcement, gate.admin.id);
  if (s.signupsEnabled !== undefined) await saveSetting("signupsEnabled", s.signupsEnabled, gate.admin.id);
  if (s.supportEmail !== undefined) await saveSetting("supportEmail", s.supportEmail, gate.admin.id);
  await audit(gate.admin, "update_settings", null, s);
  return NextResponse.json({ ok: true, settings: await getSettings() });
}

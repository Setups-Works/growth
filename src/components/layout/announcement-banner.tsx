"use client";

import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useBilling } from "@/components/providers/billing-provider";
import { cn } from "@/lib/utils";

/**
 * The site-wide announcement an admin sets in Admin → Settings — maintenance
 * windows, new features, price changes. Dismissible per browser tab; it comes
 * back on the next visit, and a changed message always shows.
 */
const TONE = {
  info: { icon: Info, cls: "border-data/25 bg-data/8 text-foreground" },
  warning: { icon: TriangleAlert, cls: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200" },
  success: { icon: CircleCheck, cls: "border-success/30 bg-success/10 text-foreground" },
} as const;

export function AnnouncementBanner() {
  const { status } = useBilling();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const a = status?.announcement;
  if (!a || dismissed === a.message) return null;
  const tone = TONE[a.tone] ?? TONE.info;
  const Icon = tone.icon;

  return (
    <div role="status" className={cn("flex items-center gap-3 border-b px-4 py-2.5 sm:px-6", tone.cls)}>
      <Icon className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-xs leading-relaxed sm:text-sm">
        {a.message}
        {a.link ? (
          <>
            {" "}
            <Link href={a.link} className="font-medium underline underline-offset-2">
              {a.linkLabel || "Learn more"}
            </Link>
          </>
        ) : null}
      </p>
      <button
        type="button"
        onClick={() => setDismissed(a.message)}
        className="rounded-md p-1 opacity-70 hover:bg-hover hover:opacity-100"
        aria-label="Dismiss announcement"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

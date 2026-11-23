"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ALL_NAV_ITEMS } from "@/components/layout/nav-items";
import { cn } from "@/lib/utils";

/**
 * The frame every app page sits in: one place for page padding, content
 * width and the page heading, so no page has to (or can forget to) do it.
 *
 * Layout: 16px side padding on phones, 24px on tablets, 32px on desktop, and
 * a 1400px maximum width so tables and charts don't stretch across an
 * ultra-wide screen. Pages that are a full-height workspace (the assistant,
 * the inbox) keep the padding but skip the large heading.
 */

const FULL_HEIGHT = ["/assistant", "/inbox"];

export function PageFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = ALL_NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const fullHeight = FULL_HEIGHT.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8",
        fullHeight ? "py-4 sm:py-5" : "pt-6 pb-12 sm:pt-8 lg:pt-10",
      )}
    >
      {!fullHeight && current ? (
        <header className="mb-6 sm:mb-8">
          <h1 className="text-[26px] leading-[1.15] font-semibold tracking-[-0.022em] text-foreground sm:text-[30px]">
            {current.label}
          </h1>
          <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-ink-3">{current.description}</p>
        </header>
      ) : null}
      {children}
    </div>
  );
}

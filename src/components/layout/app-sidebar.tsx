"use client";

import { TrendingUp, ExternalLink, Lock } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/auth/account-menu";
import { StoreSwitcher } from "@/components/layout/store-switcher";
import { useAnalytics } from "@/components/providers/analytics-provider";
import { useBilling } from "@/components/providers/billing-provider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { NAV_GROUPS } from "./nav-items";
import { BrandName } from "@/components/brand-name";

export function AppSidebar() {
  const pathname = usePathname();
  const { data } = useAnalytics();
  const { status } = useBilling();
  /*
   * Lite still sees every item -- clicking one is how it finds out WhatsApp
   * needs an upgrade, via src/proxy.ts's WHATSAPP_PAGES redirect to
   * /settings?section=billing&upgrade=whatsapp, same destination this lock
   * icon links toward. Hiding the item instead would hide the upsell along
   * with it. Only true once the plan is actually known to be Lite -- while
   * status is still loading (null) or on Go/Plus/legacy-unlimited, nothing
   * is locked.
   */
  const isLite = status !== null && !status.legacyUnlimited && status.plan === "lite";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        {/*
         * Collapsed, the rail leaves 32px inside its padding — exactly the
         * width of the menu icons below. The tile shrinks to that and drops
         * its side padding so it lines up with them instead of being clipped.
         */}
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 px-1.5 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <TrendingUp className="size-4.5" strokeWidth={2.5} />
          </span>
          <BrandName compact className="flex-1 group-data-[collapsible=icon]:hidden" />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.filter((item) => !item.admin || status?.isAdmin).map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const locked = isLite && item.whatsapp;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active} tooltip={locked ? `${item.label} — needs Go or Plus` : item.label}>
                        <Link href={locked ? "/settings?section=billing&upgrade=whatsapp" : item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {locked ? (
                        <SidebarMenuBadge>
                          <Lock className="size-3" />
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t group-data-[collapsible=icon]:hidden">
        <AccountMenu />
        <StoreSwitcher />
        {data?.meta.storeUrl ? (
          <a
            href={data.meta.storeUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-1.5 pb-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Open store <ExternalLink className="size-3" />
          </a>
        ) : null}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

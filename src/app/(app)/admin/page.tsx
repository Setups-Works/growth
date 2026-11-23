"use client";

import { Activity, CreditCard, LayoutDashboard, MessageCircle, Settings2, Store, Tag, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AdminBilling } from "@/components/admin/billing";
import { AdminOverview } from "@/components/admin/overview";
import { AdminPlans } from "@/components/admin/plans";
import { AdminSettings } from "@/components/admin/settings";
import { AdminStores } from "@/components/admin/stores";
import { AdminSystem, AdminWhatsApp } from "@/components/admin/system";
import { UserSheet } from "@/components/admin/user-sheet";
import { AdminUsers } from "@/components/admin/users";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "users", label: "Accounts", icon: Users },
  { id: "plans", label: "Plans & pricing", icon: Tag },
  { id: "billing", label: "Payments & webhook", icon: CreditCard },
  { id: "stores", label: "Stores", icon: Store },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "settings", label: "Site settings", icon: Settings2 },
  { id: "system", label: "System & audit", icon: Activity },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function AdminPage() {
  return (
    <Suspense>
      <Admin />
    </Suspense>
  );
}

function Admin() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "overview") as TabId;
  const [userId, setUserId] = useState<string | null>(null);
  // Bumped when an account changes in the drawer, so lists refetch.
  const [version, setVersion] = useState(0);

  const go = (id: TabId) => router.replace(id === "overview" ? pathname : `${pathname}?tab=${id}`, { scroll: false });

  return (
    <div className="space-y-6">
      <nav aria-label="Admin sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => go(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] whitespace-nowrap transition-colors",
                tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-ink-3 hover:text-foreground",
              )}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <div key={tab}>
        {tab === "overview" ? <AdminOverview openUser={setUserId} /> : null}
        {tab === "users" ? <AdminUsers openUser={setUserId} version={version} /> : null}
        {tab === "plans" ? <AdminPlans /> : null}
        {tab === "billing" ? <AdminBilling openUser={setUserId} /> : null}
        {tab === "stores" ? <AdminStores openUser={setUserId} /> : null}
        {tab === "whatsapp" ? <AdminWhatsApp openUser={setUserId} /> : null}
        {tab === "settings" ? <AdminSettings /> : null}
        {tab === "system" ? <AdminSystem /> : null}
      </div>

      <UserSheet id={userId} onClose={() => setUserId(null)} onChanged={() => setVersion((v) => v + 1)} />
    </div>
  );
}

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isAdminUser } from "@/lib/auth/admin";
import { currentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

/**
 * Admins only. Anyone else gets a plain 404 rather than a "forbidden" page,
 * so the panel's existence isn't advertised. Every /api/admin route checks
 * again on its own (requireAdmin) — this guard is for the page, not the data.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user || !(await isAdminUser(user.id))) notFound();
  return children;
}

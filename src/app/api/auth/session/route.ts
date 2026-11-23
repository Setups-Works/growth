import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { databaseConfigured } from "@/lib/db/client";
import { activeStore } from "@/lib/auth/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who the caller is, and how far through setup they are.
 *
 * Signing in and out happen through the sibling /api/auth/* routes. This one
 * also answers the part the browser cannot see: whether this account has a
 * store connected, and whether it has been synced. The onboarding flow is
 * driven off exactly that.
 */
export async function GET() {
  const user = await currentUser();

  if (!user) {
    return NextResponse.json({
      signedIn: false,
      configured: databaseConfigured(),
      user: null,
      store: null,
      nextStep: "sign-in",
    });
  }

  const store = await activeStore(user.id).catch(() => null);

  return NextResponse.json({
    signedIn: true,
    configured: databaseConfigured(),
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
    store: store
      ? {
          id: store.id,
          url: store.url,
          name: store.name,
          lastSyncAt: store.lastSyncAt,
          orderCount: store.orderCount,
        }
      : null,
    /*
     * A single field rather than three booleans the client has to combine.
     * Onboarding order is a product decision, and keeping it here means the
     * dashboard, the settings page and the connect screen cannot disagree
     * about what comes next.
     */
    nextStep: !store ? "connect-store" : store.orderCount === 0 ? "sync" : "ready",
  });
}

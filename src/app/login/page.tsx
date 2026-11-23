import { TrendingUp } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandName } from "@/components/brand-name";

export const metadata: Metadata = { title: "Sign in · Setups Works Growth" };

export default function Page() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16">
      <Link href="/" className="mb-8 flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <TrendingUp className="size-5" strokeWidth={2.5} />
        </span>
        <BrandName />
      </Link>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">Sign in</CardTitle>
          <CardDescription className="text-xs">Welcome back.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* useSearchParams needs a boundary, or the whole route opts out of
              static rendering. */}
          <Suspense fallback={null}>
            <AuthForm mode="sign-in" />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}

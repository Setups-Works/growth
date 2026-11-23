"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD, postJson } from "@/lib/auth/client";
import { SignUpForm } from "./sign-up-form";

/**
 * Sign in and sign up, which are the same form with a different verb. Both
 * post to this app's /api/auth/* routes, which set an HttpOnly session cookie.
 */

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  if (mode === "sign-up") return <SignUpForm next={next} />;
  return <SignInForm next={next} />;
}

function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error"));

  // Sign-up has its own form (sign-up-form.tsx); the shared markup below keeps both branches.
  const signingUp = false as boolean;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await postJson(signingUp ? "/api/auth/signup" : "/api/auth/login", { email, password });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            {!signingUp ? (
              <Link
                href="/forgot-password"
                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Forgot password?
              </Link>
            ) : null}
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signingUp ? "new-password" : "current-password"}
            required
          />
          {signingUp ? (
            <p className="text-[11px] text-muted-foreground">
              At least {MIN_PASSWORD} characters.
            </p>
          ) : null}
        </div>

        {error ? (
          <Alert>
            <AlertTitle>
              {signingUp ? "Could not create the account" : "Could not sign in"}
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Button
          type="submit"
          className="w-full gap-1.5"
          disabled={pending || !email || password.length < (signingUp ? MIN_PASSWORD : 1)}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {signingUp ? "Create account" : "Sign in"}
        </Button>
      </form>

      <p className="text-center text-xs text-muted-foreground">
        {signingUp ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="underline underline-offset-2 hover:text-foreground">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/signup" className="underline underline-offset-2 hover:text-foreground">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * `next` arrives in the query string, so it is attacker-controllable. Only a
 * path is accepted: an absolute URL would turn sign-in into an open redirect,
 * which is a credible phishing primitive precisely because the link genuinely
 * does start at this site.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

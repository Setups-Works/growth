"use client";

import { Loader2, Mail } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/auth/client";

/**
 * Requests a reset link. Never says whether the address has an account —
 * /api/auth/forgot answers the same either way, which is what stops this from
 * being a way to check who has signed up here.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await postJson("/api/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <Alert>
        <Mail />
        <AlertTitle>Check your inbox</AlertTitle>
        <AlertDescription>
          If <strong>{email}</strong> has an account, a reset link is on its way.
        </AlertDescription>
      </Alert>
    );
  }

  return (
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

      {error ? (
        <Alert>
          <AlertTitle>Could not send the reset link</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" className="w-full gap-1.5" disabled={pending || !email}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Send reset link
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        <Link href="/login" className="underline underline-offset-2 hover:text-foreground">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

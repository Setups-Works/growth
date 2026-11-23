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

/**
 * Sets a new password for whoever clicked a recovery link to get here.
 *
 * There is no "enter your current password" step: getting here at all
 * required clicking a one-time link sent to the account's own inbox, which
 * is already the proof of ownership a password-change form would otherwise
 * exist to collect.
 *
 * The link carries a one-time token in `?token=`; /api/auth/reset checks and
 * consumes it, sets the password and signs the user in.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);

    try {
      await postJson("/api/auth/reset", { token, password });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  };

  if (!token) {
    return (
      <Alert>
        <AlertTitle>This link is incomplete</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>Open the link from your reset email again, or request a new one.</p>
          <Link href="/forgot-password" className="inline-block text-xs underline underline-offset-2">
            Send a new link
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <p className="text-[11px] text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </div>

      {error ? (
        <Alert>
          <AlertTitle>Could not set the new password</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="submit"
        className="w-full gap-1.5"
        disabled={pending || password.length < MIN_PASSWORD || !confirm}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Set new password
      </Button>
    </form>
  );
}

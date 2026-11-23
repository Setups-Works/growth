"use client";

import { KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD, postJson } from "@/lib/auth/client";

/**
 * Changing a password while already signed in.
 *
 * Verified by re-entering the current one rather than trusting the open
 * session alone — a session left open on a shared device should not be
 * enough on its own to lock the real owner out.
 */
export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);

    try {
      await postJson("/api/auth/password", { current, next });
      toast.success("Password changed.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="size-4" />
          Password
        </CardTitle>
        <CardDescription className="text-xs">Change the password used to sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="current-password">Current password</Label>
              <Link
                href="/forgot-password"
                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Forgot it?
              </Link>
            </div>
            <Input
              id="current-password"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">At least {MIN_PASSWORD} characters.</p>

          {error ? (
            <Alert>
              <AlertTitle>Could not update the password</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="submit"
            size="sm"
            className="gap-1.5"
            disabled={pending || next.length < MIN_PASSWORD || !confirm || !current}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

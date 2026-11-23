"use client";

import { useEffect, useState } from "react";

/**
 * Whether someone is signed in, in the browser.
 *
 * `undefined` while unknown, which the UI renders as "nothing yet" rather
 * than guessing — guessing either way makes the header flash the wrong link.
 * The session cookie is HttpOnly, so the only way to know is to ask.
 */
export function useSignedIn(): boolean | undefined {
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { signedIn?: boolean }) => {
        if (!cancelled) setSignedIn(Boolean(data.signedIn));
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return signedIn;
}

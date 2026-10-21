"use client";

import { useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { colors } from "../lib/theme";
import { Button } from "./ui/Button";

/** Starts Clerk's GitHub sign-in. Only render this under ClerkProvider. */
export function GithubSignIn(): React.ReactElement {
  const { signIn } = useSignIn();
  const [err, setErr] = useState<string | null>(null);
  const start = () => {
    if (!signIn) return;
    void signIn
      .sso({
        strategy: "oauth_github",
        redirectUrl: "/new",
        redirectCallbackUrl: "/sso-callback",
      })
      .then((result) => {
        if (result.error) setErr(result.error.longMessage || result.error.message);
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : "GitHub sign-in is not enabled for this ShipFix app.");
      });
  };
  return (
    <div>
      <Button type="button" onClick={start}>
        Continue with GitHub
      </Button>
      {err && <p style={{ margin: "0.45rem 0 0", color: colors.error, fontSize: "0.8rem" }}>{err}</p>}
    </div>
  );
}

"use client";

import Link from "next/link";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { Landing } from "../components/Landing";
import { GithubSignIn } from "../components/GithubSignIn";
import { AUTH_MODE } from "../lib/api";
import { Button } from "../components/ui/Button";

function WelcomeActions(): React.ReactElement {
  if (AUTH_MODE === "dev") {
    return (
      <Link href="/new" style={{ textDecoration: "none" }}>
        <Button>Deploy a repo</Button>
      </Link>
    );
  }
  return (
    <>
      <GithubSignIn />
      <SignInButton mode="modal">
        <Button>Sign in</Button>
      </SignInButton>
      <SignUpButton mode="modal">
        <Button variant="ghost">Create account</Button>
      </SignUpButton>
    </>
  );
}

export default function WelcomePage(): React.ReactElement {
  return <Landing actions={<WelcomeActions />} />;
}

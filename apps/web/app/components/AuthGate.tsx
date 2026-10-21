"use client";

import { ClerkLoaded, ClerkLoading, SignInButton, SignUpButton, UserButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { AUTH_MODE, setAuthTokenProvider } from "../lib/api";
import { GithubSignIn } from "./GithubSignIn";
import { Landing } from "./Landing";
import { Button } from "./ui/Button";
import { Skeleton } from "./ui/Skeleton";

function AuthTokenBridge(): null {
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  useEffect(() => {
    setAuthTokenProvider(async () => getToken());
    return () => setAuthTokenProvider(async () => null);
  }, [getToken]);
  useEffect(() => {
    const handler = () => void signOut();
    window.addEventListener("shipfix-auth-required", handler);
    return () => window.removeEventListener("shipfix-auth-required", handler);
  }, [signOut]);
  return null;
}

function SignedOutLanding(): React.ReactElement {
  return (
    <Landing
      actions={
        <>
          <GithubSignIn />
          <SignInButton mode="modal">
            <Button>Sign in</Button>
          </SignInButton>
          <SignUpButton mode="modal">
            <Button variant="ghost">Create account</Button>
          </SignUpButton>
        </>
      }
    />
  );
}

export function AuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  if (AUTH_MODE === "dev") return <>{children}</>;
  const { isSignedIn } = useUser();
  const path = usePathname();
  if (path === "/sso-callback") {
    return (
      <ClerkLoaded>
        {children}
      </ClerkLoaded>
    );
  }

  return (
    <>
      <ClerkLoading>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
          <div style={{ width: "min(360px, 100%)", display: "grid", gap: 10 }}>
            <Skeleton height={40} />
            <Skeleton height={16} width="80%" />
            <Skeleton height={16} width="60%" />
          </div>
        </main>
      </ClerkLoading>
      <ClerkLoaded>
        {!isSignedIn ? (
          path === "/welcome" || path === "/benchmark" || path === "/errors" || path.startsWith("/errors/") ? (
            children
          ) : (
            <SignedOutLanding />
          )
        ) : (
          <>
            <AuthTokenBridge />
            <div style={{ position: "fixed", top: 18, right: 18, zIndex: 20 }}>
              <UserButton />
            </div>
            {children}
          </>
        )}
      </ClerkLoaded>
    </>
  );
}

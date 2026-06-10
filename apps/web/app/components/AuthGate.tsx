"use client";

import { ClerkLoaded, ClerkLoading, SignIn, SignInButton, SignUpButton, UserButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useEffect } from "react";
import { AUTH_MODE, setAuthTokenProvider } from "../lib/api";
import { buttonStyle, card, colors } from "../lib/theme";
import { BrandMark } from "./BrandMark";

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

function LoginScreen(): React.ReactElement {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <section style={{ ...card, width: "min(460px, 100%)", padding: "2rem", textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "1.25rem" }}>
          <BrandMark />
        </div>
        <h1 style={{ margin: 0, fontSize: "1.75rem", letterSpacing: 0 }}>Deploy with a verified trail</h1>
        <p style={{ color: colors.dim, margin: "0.75rem 0 1.5rem", lineHeight: 1.6 }}>
          Sign in to analyze repos, connect provider accounts, deploy services, and keep a record of what is live.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <SignInButton mode="modal">
            <button style={buttonStyle("primary")}>Sign in</button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button style={buttonStyle("ghost")}>Create account</button>
          </SignUpButton>
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginTop: "1.5rem" }}>
          <SignIn routing="hash" />
        </div>
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  if (AUTH_MODE === "dev") return <>{children}</>;
  const { isSignedIn } = useUser();

  return (
    <>
      <ClerkLoading>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: colors.dim }}>
          Loading ShipFix sign-in...
        </main>
      </ClerkLoading>
      <ClerkLoaded>
        {!isSignedIn ? (
          <LoginScreen />
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

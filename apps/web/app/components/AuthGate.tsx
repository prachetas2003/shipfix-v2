"use client";

import { ClerkLoaded, ClerkLoading, SignIn, SignInButton, SignUpButton, UserButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useEffect } from "react";
import { AUTH_MODE, setAuthTokenProvider } from "../lib/api";
import { buttonStyle, card, colors } from "../lib/theme";

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
      <section style={{ ...card, width: "min(440px, 100%)", padding: "2rem", textAlign: "center" }}>
        <h1 style={{ margin: 0, fontSize: "1.75rem" }}>Sign in to deploy your apps with ShipFix</h1>
        <p style={{ color: colors.dim, margin: "0.75rem 0 1.5rem" }}>
          Use your account to plan deployments, connect providers, and track your apps safely.
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
          Loading sign-in...
        </main>
      </ClerkLoading>
      <ClerkLoaded>
        {!isSignedIn ? (
          <LoginScreen />
        ) : (
          <>
          <AuthTokenBridge />
          <div style={{ position: "fixed", top: 16, right: 16, zIndex: 20 }}>
            <UserButton />
          </div>
          {children}
          </>
        )}
      </ClerkLoaded>
    </>
  );
}

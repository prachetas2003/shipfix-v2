import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { AuthGate } from "./components/AuthGate";
import "./globals.css";

export const metadata = {
  title: "ShipFix",
  description: "AI-assisted deployment planning, provider setup, deployment, and live verification.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          margin: 0,
          background: "#08090b",
          color: "#ededed",
        }}
      >
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
  if (process.env.NEXT_PUBLIC_AUTH_MODE === "dev") return body;
  return <ClerkProvider>{body}</ClerkProvider>;
}

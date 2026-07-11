import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AuthGate } from "./components/AuthGate";
import "./globals.css";

export const metadata = {
  title: "ShipFix",
  description: "AI-assisted deployment planning, provider setup, deployment, and live verification.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
  if (process.env.NEXT_PUBLIC_AUTH_MODE === "dev") return body;
  return <ClerkProvider>{body}</ClerkProvider>;
}

import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { Syne } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Atmosphere } from "./components/Atmosphere";
import { AuthGate } from "./components/AuthGate";
import "./globals.css";

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-syne",
  display: "swap",
  weight: ["500", "600", "700", "800"],
});

export const metadata = {
  title: "ShipFix",
  description: "ShipFix deploys a full-stack app into your own Vercel, Render, Neon, and Supabase accounts, then checks that it came up.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${syne.variable}`}>
      <body>
        <Atmosphere />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
  if (process.env.NEXT_PUBLIC_AUTH_MODE === "dev") return body;
  return <ClerkProvider>{body}</ClerkProvider>;
}

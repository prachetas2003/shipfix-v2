import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { AuthGate } from "./components/AuthGate";

export const metadata = {
  title: "ShipFix",
  description: "Autonomous deployment engineer.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          margin: 0,
          background: "#0a0a0a",
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

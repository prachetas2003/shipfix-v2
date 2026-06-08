import type { ReactNode } from "react";

export const metadata = {
  title: "ShipFix",
  description: "Autonomous deployment engineer.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          margin: 0,
          background: "#0a0a0a",
          color: "#ededed",
        }}
      >
        {children}
      </body>
    </html>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConnectProvider } from "../components/ConnectProvider";
import { AppNav, Button, PageHeader, Shell } from "../components/ui";
import { api } from "../lib/api";
import { ALL_PROVIDER_IDS } from "../lib/providerGuide";
import { colors } from "../lib/theme";

export default function ProvidersPage(): React.ReactElement {
  const [connected, setConnected] = useState<string[]>([]);
  const [oauth, setOauth] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const [providers, oauthProviders] = await Promise.all([
      api.listProviders().catch(() => ({ connected: [] as string[] })),
      api.listOauthProviders().catch(() => ({ providers: [] as string[] })),
    ]);
    setConnected(providers.connected);
    setOauth(oauthProviders.providers);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Shell>
      <AppNav
        right={
          <Link href="/new" style={{ textDecoration: "none" }}>
            <Button>New deployment</Button>
          </Link>
        }
      />
      <PageHeader
        title="Providers"
        subtitle="Connect each host once. ShipFix creates a separate project for every app. Vercel, Neon, and Supabase can use a login when this server is configured for it. Render and Upstash use an account key."
      />
      {ALL_PROVIDER_IDS.map((id) => (
        <ConnectProvider
          key={id}
          providerId={id}
          connected={connected.includes(id)}
          allowUpdate
          oauthReady={oauth.includes(id)}
          onConnected={() => void refresh()}
        />
      ))}
      <p style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", color: colors.dim, lineHeight: 1.5 }}>
        Disconnect removes the sealed key from ShipFix. It does not delete resources already created in that account.
      </p>
    </Shell>
  );
}

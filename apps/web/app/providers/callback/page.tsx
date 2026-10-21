"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AppNav, Button, PageHeader, Panel, Shell } from "../../components/ui";
import { api } from "../../lib/api";
import { providerGuide } from "../../lib/providerGuide";
import { colors } from "../../lib/theme";

type State = { kind: "working" } | { kind: "done"; name: string } | { kind: "error"; message: string };

function ProviderCallback(): React.ReactElement {
  const params = useSearchParams();
  const [state, setState] = useState<State>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const error = params.get("error_description") || params.get("error");
    if (error) {
      setState({ kind: "error", message: "The provider login was cancelled." });
      return;
    }
    const code = params.get("code");
    const oauthState = params.get("state");
    if (!code || !oauthState) {
      setState({ kind: "error", message: "The provider did not return a login code. Start the connection again." });
      return;
    }
    const verifier = sessionStorage.getItem(`shipfix-oauth:${oauthState}`) ?? undefined;
    sessionStorage.removeItem(`shipfix-oauth:${oauthState}`);
    api
      .finishProviderOauth({
        code,
        state: oauthState,
        redirectUri: `${window.location.origin}/providers/callback`,
        verifier,
      })
      .then((r) => setState({ kind: "done", name: providerGuide(r.provider)?.name ?? r.provider }))
      .catch((e: unknown) => setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [params]);

  return (
    <Panel className="sf-slide-up">
      {state.kind === "working" && <p style={{ margin: 0 }}>Saving the provider connection…</p>}
      {state.kind === "done" && (
        <>
          <strong style={{ fontWeight: 600 }}>{state.name} connected</strong>
          <p style={{ margin: "0.45rem 0 0", color: colors.dim, lineHeight: 1.55 }}>
            ShipFix sealed the token. It is not shown again.
          </p>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <Link href="/providers" style={{ textDecoration: "none" }}>
              <Button>Back to providers</Button>
            </Link>
            <Link href="/new" style={{ textDecoration: "none" }}>
              <Button variant="ghost">Deploy a repo</Button>
            </Link>
          </div>
        </>
      )}
      {state.kind === "error" && (
        <div style={{ color: colors.errorText }}>
          <strong style={{ fontWeight: 600 }}>Could not connect the provider</strong>
          <p style={{ margin: "0.45rem 0 0", lineHeight: 1.55 }}>{state.message}</p>
          <div style={{ marginTop: 14 }}>
            <Link href="/providers" style={{ textDecoration: "none" }}>
              <Button variant="ghost">Back to providers</Button>
            </Link>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function ProviderCallbackPage(): React.ReactElement {
  return (
    <Shell>
      <AppNav />
      <PageHeader title="Connect provider" subtitle="Finishing the login and sealing the token." />
      <Suspense fallback={<Panel>Loading…</Panel>}>
        <ProviderCallback />
      </Suspense>
    </Shell>
  );
}

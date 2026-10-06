"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { colors } from "../../lib/theme";
import { AppNav, Button, PageHeader, Panel, Shell } from "../../components/ui";

type State =
  | { kind: "working" }
  | { kind: "done"; accounts: string[] }
  | { kind: "error"; message: string };

function GithubCallback(): React.ReactElement {
  const params = useSearchParams();
  const [state, setState] = useState<State>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code");
    const installationId = params.get("installation_id") ?? undefined;
    if (!code) {
      setState({
        kind: "error",
        message:
          "GitHub did not return an authorization code. Make sure the ShipFix GitHub App requests user authorization during installation, then try again.",
      });
      return;
    }
    api
      .claimGithubInstallation(code, installationId)
      .then((r) => setState({ kind: "done", accounts: r.accounts }))
      .catch((e: unknown) => setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [params]);

  return (
    <Panel className="sf-slide-up">
      {state.kind === "working" && <p style={{ margin: 0 }}>Confirming your GitHub installation…</p>}
      {state.kind === "done" && (
        <>
          <strong style={{ fontWeight: 600 }}>GitHub connected</strong>
          <p style={{ margin: "0.45rem 0 0", color: colors.dim, lineHeight: 1.55 }}>
            ShipFix can now read repositories you granted to{" "}
            {state.accounts.length ? state.accounts.join(", ") : "your installation"}, including private ones.
          </p>
          <div style={{ marginTop: 14 }}>
            <Link href="/new" style={{ textDecoration: "none" }}>
              <Button>Deploy a repo</Button>
            </Link>
          </div>
        </>
      )}
      {state.kind === "error" && (
        <div style={{ color: colors.errorText }}>
          <strong style={{ fontWeight: 600 }}>Could not connect GitHub</strong>
          <p style={{ margin: "0.45rem 0 0", lineHeight: 1.55 }}>{state.message}</p>
          <div style={{ marginTop: 14 }}>
            <Link href="/new" style={{ textDecoration: "none" }}>
              <Button variant="ghost">Back</Button>
            </Link>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function GithubCallbackPage(): React.ReactElement {
  return (
    <Shell>
      <AppNav />
      <PageHeader title="Connect GitHub" subtitle="Linking your GitHub App installation to ShipFix." />
      <Suspense fallback={<Panel>Loading…</Panel>}>
        <GithubCallback />
      </Suspense>
    </Shell>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { api, type AppDetail } from "../../lib/api";
import { buildAppResourceDisplay } from "../../lib/resourceDisplay";
import { deriveRequiredProviders, missingProviders } from "../../lib/planRequirements";
import { runModeLabel, runStatusLabel } from "../../lib/runLabels";
import { colors, mono } from "../../lib/theme";
import { CurrentState } from "../../components/CurrentState";
import { ProviderRequirements } from "../../components/ProviderRequirements";
import { VerificationChecklist } from "../../components/VerificationChecklist";
import { ProjectEnvPanel } from "../../components/ProjectEnvPanel";
import { AppNav, Badge, Button, PageHeader, Panel, Shell, Skeleton, Tabs } from "../../components/ui";

function runBadgeTone(status: string): "success" | "warn" | "error" | "neutral" | "info" {
  if (status === "succeeded") return "success";
  if (status === "diagnosed") return "warn";
  if (status === "failed") return "error";
  if (["queued", "analyzing", "planning", "provisioning", "deploying", "verifying"].includes(status)) return "info";
  return "neutral";
}

export default function AppDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.ReactElement {
  const { projectId } = use(params);
  const router = useRouter();
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [starting, setStarting] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const [savingAutoDeploy, setSavingAutoDeploy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [app, providers] = await Promise.all([api.getApp(projectId), api.listProviders()]);
      setDetail(app);
      setConnected(providers.connected);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const latest = detail?.history[0];
    if (!latest) return;
    const active = !["succeeded", "diagnosed", "failed"].includes(latest.status);
    if (!active) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [detail?.history, load]);

  const visibleDeployment = detail?.latestLiveDeployment ?? detail?.current;
  const display =
    visibleDeployment &&
    buildAppResourceDisplay({
      resources: visibleDeployment.resources,
      layers: visibleDeployment.layers,
      verification: visibleDeployment.verification,
    });

  const noLiveDeployment = !detail?.latestLiveDeployment && !display?.fullStack.live;
  const action = detail?.deployAction ?? null;
  const latestRun = detail?.history[0];
  const latestRunNeedsDeployAction =
    latestRun?.mode === "deploy" && (latestRun.status === "failed" || latestRun.status === "diagnosed");
  const showDeployAction = Boolean(action && (noLiveDeployment || latestRunNeedsDeployAction));

  const startDeploy = async () => {
    if (!action) return;
    setErr(null);
    const providers = await api.listProviders().catch(() => ({ connected }));
    setConnected(providers.connected);
    const requiredPlanMissing = missingProviders(deriveRequiredProviders(action.plan), providers.connected);
    if (requiredPlanMissing.length > 0) {
      setShowConnect(true);
      setTab("overview");
      return;
    }
    setStarting(true);
    try {
      const runId = await api.startDeployFromRun(action.sourceRunId);
      router.push(`/runs/${runId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const redeployLatest = async () => {
    setErr(null);
    setRedeploying(true);
    try {
      const { runId } = await api.redeployLatest(projectId);
      router.push(`/runs/${runId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRedeploying(false);
    }
  };

  const toggleAutoDeploy = async () => {
    if (!detail) return;
    setErr(null);
    setSavingAutoDeploy(true);
    try {
      const next = !detail.project.autoDeployOnPush;
      await api.updateApp(projectId, { autoDeployOnPush: next });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAutoDeploy(false);
    }
  };

  return (
    <Shell>
      <AppNav
        right={
          <>
            <Button onClick={() => void redeployLatest()} disabled={redeploying}>
              {redeploying ? "Starting…" : "Redeploy latest"}
            </Button>
            <Link href="/new" style={{ textDecoration: "none" }}>
              <Button variant="ghost">New</Button>
            </Link>
          </>
        }
      />

      <PageHeader
        eyebrow={
          <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.82rem" }}>
            Apps
          </Link>
        }
        title={
          <span style={{ fontFamily: mono, fontSize: "1.35rem", wordBreak: "break-word" }}>
            {detail?.project.repoFullName ?? "App"}
          </span>
        }
        subtitle={
          display?.fullStack.live
            ? "Latest verified live deployment."
            : action
              ? "Plan ready — not verified live yet."
              : "Deployment state and history."
        }
      />

      {err && (
        <Panel style={{ borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText, marginBottom: "1rem" }}>
          {err}
        </Panel>
      )}

      {loading && !detail ? (
        <div style={{ display: "grid", gap: 10 }}>
          <Skeleton height={64} />
          <Skeleton height={180} />
        </div>
      ) : (
        <>
          <Tabs
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "environment", label: "Environment" },
              { id: "deployments", label: "Deployments" },
              { id: "settings", label: "Settings" },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === "overview" && (
            <div className="sf-fade-in">
              {latestRun && (
                <Panel style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: "1rem" }}>
                  <div style={{ flex: "1 1 280px" }}>
                    <div style={{ fontSize: "0.72rem", color: colors.dim, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                      Latest run
                    </div>
                    <p style={{ margin: "0.3rem 0 0", color: colors.muted, fontSize: "0.9rem" }}>
                      {runStatusLabel(latestRun.mode, latestRun.status)} · {runModeLabel(latestRun.mode)}
                    </p>
                  </div>
                  <Badge tone={runBadgeTone(latestRun.status)}>{runStatusLabel(latestRun.mode, latestRun.status)}</Badge>
                  <Link href={`/runs/${latestRun.id}`} style={{ textDecoration: "none" }}>
                    <Button variant="ghost">Open run</Button>
                  </Link>
                </Panel>
              )}

              {showDeployAction && action && (
                <Panel style={{ marginBottom: "1rem", borderColor: colors.warnBorder }}>
                  <p style={{ color: colors.warnText, fontWeight: 600, margin: 0 }}>
                    {latestRunNeedsDeployAction
                      ? "Latest deploy needs attention. Previous live links are preserved."
                      : "Plan ready, but the app is not deployed yet."}
                  </p>
                  <p style={{ color: colors.dim, margin: "0.4rem 0 0.85rem", lineHeight: 1.5, fontSize: "0.88rem" }}>
                    Retry this plan, or redeploy the tip of{" "}
                    <code style={{ fontFamily: mono }}>{detail?.project.defaultBranch ?? "main"}</code>.
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button variant="ghost" onClick={() => void startDeploy()} disabled={starting}>
                      {starting ? "Starting…" : action.label}
                    </Button>
                    <Button onClick={() => void redeployLatest()} disabled={redeploying}>
                      {redeploying ? "Starting…" : "Redeploy latest"}
                    </Button>
                    <Button variant="ghost" onClick={() => setShowConnect((v) => !v)}>
                      Update a provider
                    </Button>
                  </div>
                  {showConnect && (
                    <div style={{ marginTop: 12 }}>
                      <ProviderRequirements plan={action.plan} connected={connected} onConnected={() => void load()} allowUpdate />
                    </div>
                  )}
                </Panel>
              )}

              {display && (
                <div>
                  {detail?.latestLiveDeployment && detail.current?.runId !== detail.latestLiveDeployment.runId && (
                    <p style={{ color: colors.warn, fontSize: "0.85rem", marginTop: 0, lineHeight: 1.5 }}>
                      Latest run is {runStatusLabel(latestRun?.mode ?? "", latestRun?.status ?? "")}. Showing the most recent verified live deployment.
                    </p>
                  )}
                  <CurrentState display={display} />
                  {visibleDeployment && visibleDeployment.verification.length > 0 && (
                    <Panel style={{ marginTop: "0.85rem" }}>
                      <VerificationChecklist verification={visibleDeployment.verification} plan={action?.plan ?? null} />
                    </Panel>
                  )}
                </div>
              )}

              {!display && (
                <Panel>
                  <p style={{ margin: 0, color: colors.dim }}>No deployment resources yet. Start a deploy from a plan or redeploy latest.</p>
                </Panel>
              )}
            </div>
          )}

          {tab === "environment" && (
            <div className="sf-fade-in">
              <ProjectEnvPanel projectId={projectId} />
            </div>
          )}

          {tab === "deployments" && (
            <div className="sf-fade-in">
              {detail?.history.length === 0 && (
                <Panel>
                  <p style={{ margin: 0, color: colors.dim }}>No runs yet.</p>
                </Panel>
              )}
              <div style={{ display: "grid", gap: 8 }}>
                {detail?.history.map((r) => (
                  <Link key={r.id} href={`/runs/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                    <Panel
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        flexWrap: "wrap",
                        cursor: "pointer",
                        padding: "0.85rem 1rem",
                      }}
                    >
                      <Badge tone={runBadgeTone(r.status)}>{runStatusLabel(r.mode, r.status)}</Badge>
                      <span style={{ color: colors.muted, fontSize: "0.85rem" }}>{runModeLabel(r.mode)}</span>
                      <span style={{ color: colors.dim, fontSize: "0.8rem", fontFamily: mono }}>{r.commitSha.slice(0, 8)}</span>
                      <span style={{ marginLeft: "auto", color: colors.dim, fontSize: "0.78rem" }}>
                        {new Date(r.startedAt).toLocaleString()}
                      </span>
                    </Panel>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {tab === "settings" && detail && (
            <div className="sf-fade-in">
              <Panel>
                <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Auto-deploy on push</h2>
                <p style={{ margin: "0.4rem 0 0.9rem", color: colors.dim, lineHeight: 1.55, fontSize: "0.88rem" }}>
                  When enabled, pushes to <code style={{ fontFamily: mono }}>{detail.project.defaultBranch}</code> start a
                  full deploy (still gated and verified). Requires the ShipFix GitHub App webhook.
                </p>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    cursor: savingAutoDeploy ? "wait" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={detail.project.autoDeployOnPush}
                    disabled={savingAutoDeploy}
                    onChange={() => void toggleAutoDeploy()}
                  />
                  <span style={{ fontWeight: 600 }}>
                    {detail.project.autoDeployOnPush ? "On" : "Off"}
                    {savingAutoDeploy ? " (saving…)" : ""}
                  </span>
                </label>
              </Panel>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

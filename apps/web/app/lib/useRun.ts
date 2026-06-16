"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, api, withAuthQuery, type PlanView, type RunEventRow, type RunSnapshot } from "./api";

export type LiveStatus =
  | "loading"
  | "streaming"
  | "succeeded"
  | "diagnosed"
  | "failed"
  | "error";

const TERMINAL = new Set(["succeeded", "diagnosed", "failed"]);

/**
 * A run that sits in "queued" with zero timeline events for this long has no
 * worker picking it up (worker down/unreachable). Surface that honestly
 * instead of letting the page imply work is happening.
 */
const QUEUED_STALL_MS = 45_000;
const QUEUED_POLL_MS = 10_000;

function normalize(status: string): LiveStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "diagnosed") return "diagnosed";
  if (status === "failed" || status === "not_found") return "failed";
  return "streaming";
}

/**
 * Subscribe to one run: hydrate from the snapshot endpoint (survives refresh),
 * and if the run is still in progress, stream live events over SSE and refresh
 * the snapshot on completion. Authoritative links/layers come from the snapshot.
 */
export function useRun(runId: string | null): {
  status: LiveStatus;
  events: RunEventRow[];
  plan: PlanView | null;
  repoContext: unknown;
  snapshot: RunSnapshot | null;
  error: string | null;
  /** True when the run sits "queued" with no events — the worker is not picking it up. */
  workerStalled: boolean;
  /** True when the worker could not find this run in its database. */
  controlPlaneMismatch: boolean;
} {
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [repoContext, setRepoContext] = useState<unknown>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workerStalled, setWorkerStalled] = useState(false);
  const [controlPlaneMismatch, setControlPlaneMismatch] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const eventCountRef = useRef(0);

  const loadSnapshot = useCallback(async (id: string) => {
    try {
      const snap = await api.getRunSnapshot(id);
      setSnapshot(snap);
      if (snap.plan) setPlan(snap.plan);
      return snap;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setStatus("loading");
    setEvents([]);
    setPlan(null);
    setRepoContext(null);
    setSnapshot(null);
    setError(null);
    setWorkerStalled(false);
    setControlPlaneMismatch(false);
    eventCountRef.current = 0;

    // Worker-down watchdog: while the run is queued and silent, re-check the
    // snapshot; past the stall window, tell the user the worker is not running.
    const startedWatching = Date.now();
    const stallTimer = setInterval(() => {
      if (cancelled || eventCountRef.current > 0) {
        clearInterval(stallTimer);
        return;
      }
      void loadSnapshot(runId).then((snap) => {
        if (cancelled || !snap) return;
        if (snap.run.status !== "queued") {
          if (eventCountRef.current > 0 || TERMINAL.has(snap.run.status)) clearInterval(stallTimer);
          setWorkerStalled(false);
          return;
        }
        const queuedSinceMs = Date.now() - Math.min(new Date(snap.run.startedAt).getTime(), startedWatching);
        if (queuedSinceMs > QUEUED_STALL_MS) setWorkerStalled(true);
      });
    }, QUEUED_POLL_MS);

    void (async () => {
      const snap = await loadSnapshot(runId);
      if (cancelled) return;
      // Failed runs still need SSE replay so timeline + failure diagnostics hydrate on refresh.
      if (snap && TERMINAL.has(snap.run.status) && snap.run.status !== "failed") {
        setStatus(normalize(snap.run.status));
        return;
      }

      const es = new EventSource(await withAuthQuery(`${API_BASE}/runs/${runId}/events`));
      esRef.current = es;
      setStatus("streaming");

      es.addEventListener("run_event", (e) => {
        const row = JSON.parse((e as MessageEvent).data) as RunEventRow;
        eventCountRef.current += 1;
        setWorkerStalled(false);
        setEvents((prev) => (prev.some((p) => p.seq === row.seq) ? prev : [...prev, row]));
        if (row.data?.event === "internal_control_plane_consistency_error") {
          setControlPlaneMismatch(true);
          setWorkerStalled(false);
        }
        if (row.data?.event === "analysis_completed" && row.data.repoContext) {
          setRepoContext(row.data.repoContext);
        }
        if (row.data?.event === "plan_validated" && row.data.plan) {
          setPlan(row.data.plan as PlanView);
        }
        const ev = row.data?.event;
        const stage = row.data?.stage ?? row.stage;
        if (
          ev === "verification" ||
          ev === "service_deployed" ||
          ev === "verify_skipped" ||
          stage === "succeeded" ||
          stage === "diagnosed" ||
          stage === "failed" ||
          stage === "verifying"
        ) {
        void loadSnapshot(runId).then((snap) => {
          if (!cancelled && snap) {
            setSnapshot(snap);
            if (snap.run.status === "failed") setWorkerStalled(false);
          }
        });
        }
      });

      es.addEventListener("end", (e) => {
        const { status: final } = JSON.parse((e as MessageEvent).data) as { status: string };
        es.close();
        esRef.current = null;
        void loadSnapshot(runId).then(() => {
          if (!cancelled) setStatus(normalize(final));
        });
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (!cancelled) {
          setStatus((s) => (s === "streaming" ? "error" : s));
          setError("Lost connection to the live event stream.");
        }
      };
    })();

    return () => {
      cancelled = true;
      clearInterval(stallTimer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [runId, loadSnapshot]);

  return { status, events, plan, repoContext, snapshot, error, workerStalled, controlPlaneMismatch };
}

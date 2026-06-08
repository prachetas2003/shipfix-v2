"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, api, withAlphaTokenQuery, type PlanView, type RunEventRow, type RunSnapshot } from "./api";

export type LiveStatus =
  | "loading"
  | "streaming"
  | "succeeded"
  | "diagnosed"
  | "failed"
  | "error";

const TERMINAL = new Set(["succeeded", "diagnosed", "failed"]);

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
} {
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [repoContext, setRepoContext] = useState<unknown>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

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

    void (async () => {
      const snap = await loadSnapshot(runId);
      if (cancelled) return;
      if (snap && TERMINAL.has(snap.run.status)) {
        setStatus(normalize(snap.run.status));
        return; // finished run: render from snapshot, no SSE needed
      }

      const es = new EventSource(withAlphaTokenQuery(`${API_BASE}/runs/${runId}/events`));
      esRef.current = es;
      setStatus("streaming");

      es.addEventListener("run_event", (e) => {
        const row = JSON.parse((e as MessageEvent).data) as RunEventRow;
        setEvents((prev) => (prev.some((p) => p.seq === row.seq) ? prev : [...prev, row]));
        if (row.data?.event === "analysis_completed" && row.data.repoContext) {
          setRepoContext(row.data.repoContext);
        }
        if (row.data?.event === "plan_validated" && row.data.plan) {
          setPlan(row.data.plan as PlanView);
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
      esRef.current?.close();
      esRef.current = null;
    };
  }, [runId, loadSnapshot]);

  return { status, events, plan, repoContext, snapshot, error };
}

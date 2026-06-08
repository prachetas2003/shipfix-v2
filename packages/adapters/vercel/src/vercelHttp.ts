import type { DeployFailureKind } from "@shipfix/adapter-core";
import { redact } from "@shipfix/secrets";

export interface VercelFailure {
  kind: DeployFailureKind;
  message: string;
}

export async function readVercelBody(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

/** Classify Vercel API errors into setup blockers vs hard deploy failures. */
export function classifyVercelFailure(status: number, statusText: string, bodyText: string): VercelFailure {
  const preview = redact(bodyText).trim();
  try {
    const json = JSON.parse(bodyText) as {
      error?: { code?: string; message?: string; action?: string; link?: string };
    };
    const err = json.error;
    const msg = err?.message ?? preview;
    const link = err?.link ? ` See ${err.link}` : "";
    if (
      err?.code === "bad_request" &&
      /login connection|connect.*github|github account/i.test(msg)
    ) {
      return {
        kind: "setup_blocker",
        message: `Vercel GitHub connection required: ${msg}. Connect GitHub in your Vercel account (Login Connection), then rerun Deploy.${link}`,
      };
    }
    if (
      err?.code === "bad_request" &&
      /gitSource.*repoId|repoId.*required|missing required property.*repoId/i.test(msg)
    ) {
      return {
        kind: "setup_blocker",
        message: `Vercel git deployment requires a linked GitHub repoId: ${msg}. Ensure the repo is connected in Vercel and rerun Deploy.${link}`,
      };
    }
    if (err?.message) {
      return {
        kind: "deploy_failed",
        message: `Vercel API HTTP ${status}: ${redact(err.message).slice(0, 500)}${link}`,
      };
    }
  } catch {
    /* fall through */
  }
  const detail = preview.length > 0 ? preview.slice(0, 500) : "(empty body)";
  return {
    kind: "deploy_failed",
    message: `Vercel API HTTP ${status} ${statusText}: ${detail}`,
  };
}

export async function failVercelBody(res: Response, action: string): Promise<never> {
  const body = await readVercelBody(res);
  const classified = classifyVercelFailure(res.status, res.statusText, body);
  throw new Error(classified.message);
}

export async function parseVercelJson<T>(res: Response, action: string): Promise<T> {
  const body = await readVercelBody(res);
  if (!body.trim()) {
    throw new Error(`Vercel API ${action} returned empty body (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    const classified = classifyVercelFailure(res.status, res.statusText, body);
    throw new Error(classified.message);
  }
}

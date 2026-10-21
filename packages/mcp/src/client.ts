export class ShipfixApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ShipfixClientOptions {
  baseUrl: string;
  /** Clerk session token. Omit in dev when devUser is set. */
  token?: string;
  /** Sent as x-shipfix-dev-user when the API is in AUTH_MODE=dev. */
  devUser?: string;
  fetchImpl?: typeof fetch;
}

export interface LogLine {
  seq: number;
  level: string;
  message: string;
}

/** HTTP client for the existing ShipFix API. Never logs the token. */
export function createShipfixClient(opts: ShipfixClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (opts.devUser) headers.set("x-shipfix-dev-user", opts.devUser);
    else if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
    if (init.body) headers.set("content-type", "application/json");
    const res = await fetchImpl(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : `ShipFix API returned ${res.status}`;
      throw new ShipfixApiError(res.status, message);
    }
    return body;
  }

  return {
    deploy(input: { repo: string; branch?: string }) {
      const repoFullName = input.repo.includes("github.com") ? undefined : input.repo;
      return request("/runs/deploy", {
        method: "POST",
        body: JSON.stringify({
          ...(repoFullName ? { repoFullName } : { repoUrl: input.repo }),
          ...(input.branch ? { branch: input.branch } : {}),
        }),
      });
    },
    status(runId: string) {
      return request(`/runs/${runId}`);
    },
    logs(runId: string, limit = 80) {
      return request(`/runs/${runId}/logs?limit=${limit}`) as Promise<{ lines: LogLine[] }>;
    },
    redeploy(runId: string) {
      return request(`/runs/${runId}/deploy`, { method: "POST" });
    },
  };
}

export type ShipfixClient = ReturnType<typeof createShipfixClient>;

import { deployTool, fixTool, logsTool, statusTool } from "./tools";
import type { ShipfixClient } from "./client";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "deploy",
    description: "Start a ShipFix deploy of a GitHub repo into the user's own accounts. Returns a run id.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo or a GitHub URL" },
        branch: { type: "string", description: "Branch to deploy. Defaults to the repo's default branch." },
      },
      required: ["repo"],
    },
  },
  {
    name: "status",
    description: "Status of a ShipFix run: stage, plan, live URLs, and questions still waiting.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
  {
    name: "logs",
    description: "Recent redacted log lines for a ShipFix run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, limit: { type: "number" } },
      required: ["runId"],
    },
  },
  {
    name: "fix",
    description:
      "Ask ShipFix to repair a failed deploy and redeploy. If the run is waiting on the user, returns the questions instead of redeploying.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
];

function args(params: unknown): Record<string, unknown> {
  const p = params && typeof params === "object" ? (params as { arguments?: unknown; name?: unknown }) : {};
  return p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};
}

function text(value: string, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

async function callTool(client: ShipfixClient, name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "deploy") {
    const repo = typeof input.repo === "string" ? input.repo.trim() : "";
    if (!repo) throw new Error("repo is required");
    return deployTool(client, repo, typeof input.branch === "string" ? input.branch : undefined);
  }
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) throw new Error("runId is required");
  if (name === "status") return statusTool(client, runId);
  if (name === "logs") return logsTool(client, runId, typeof input.limit === "number" ? input.limit : undefined);
  if (name === "fix") return fixTool(client, runId);
  throw new Error(`Unknown tool ${name}`);
}

/** One MCP JSON-RPC message. Notifications return null (no response). */
export async function handleRpc(msg: JsonRpcRequest, client: ShipfixClient): Promise<object | null> {
  if (msg.id === undefined || msg.id === null || msg.method.startsWith("notifications/")) return null;
  try {
    if (msg.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "shipfix", version: "0.0.0" },
        },
      };
    }
    if (msg.method === "tools/list") {
      return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
    }
    if (msg.method === "tools/call") {
      const name = (msg.params as { name?: string } | undefined)?.name ?? "";
      try {
        const value = await callTool(client, name, args(msg.params));
        return { jsonrpc: "2.0", id: msg.id, result: text(value) };
      } catch (err) {
        const message = err instanceof Error ? err.message : "ShipFix tool failed";
        return { jsonrpc: "2.0", id: msg.id, result: text(message, true) };
      }
    }
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
    };
  }
}

/** Read one Content-Length framed MCP message. Returns null until the frame is complete. */
export function takeFrame(buf: Buffer): { message: unknown; rest: Buffer } | null {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep === -1) return null;
  const header = buf.subarray(0, sep).toString("utf8");
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) return null;
  const length = Number(match[1]);
  const start = sep + 4;
  if (buf.length < start + length) return null;
  const json = buf.subarray(start, start + length).toString("utf8");
  return { message: JSON.parse(json) as unknown, rest: buf.subarray(start + length) };
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

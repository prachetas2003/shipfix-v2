import { createShipfixClient } from "./client";
import { encodeFrame, handleRpc, takeFrame, type JsonRpcRequest } from "./rpc";

/** stdio MCP server. Cursor and Claude Code spawn this process. */
export async function serveStdio(client = createShipfixClient({
  baseUrl: process.env.SHIPFIX_API_URL?.trim() || "http://localhost:4000",
  token: process.env.SHIPFIX_TOKEN?.trim() || undefined,
  devUser: process.env.SHIPFIX_DEV_USER?.trim() || undefined,
})): Promise<void> {
  let buf: Buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const frame = takeFrame(buf);
      if (!frame) break;
      buf = frame.rest;
      const response = await handleRpc(frame.message as JsonRpcRequest, client);
      if (response) process.stdout.write(encodeFrame(response));
    }
  }
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/src/server.ts") || entry.endsWith("/src/server.js")) {
  serveStdio().catch((err) => {
    process.stderr.write(err instanceof Error ? err.message : "shipfix mcp failed");
    process.exit(1);
  });
}

import type { Fix, FixContext } from "../types";
import { CODE_FILE_RE, IGNORED_DIR_RE, isUnder } from "../util";

const READS_PORT_RE = /process\.env\.PORT\b|process\.env\[\s*['"]PORT['"]\s*\]|Deno\.env\.get\(\s*['"]PORT['"]/;
const TEST_FILE_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const LOOPBACK = /(['"])(?:localhost|127\.0\.0\.1)\1/;

/** Rewrite one file so its server listens on $PORT on all interfaces. Null when unchanged. */
export function bindToPort(content: string): string | null {
  if (READS_PORT_RE.test(content) || !/\.listen\s*\(/.test(content)) return null;
  let out = content;

  // app.listen(3000 …) and server.listen(3000, 'localhost' …)
  out = out.replace(/\.listen\(\s*(\d{2,5})\b(\s*,\s*)?((['"])(?:localhost|127\.0\.0\.1)\4)?/g, (_m, port: string, comma?: string, host?: string) =>
    `.listen(Number(process.env.PORT) || ${port}${comma ?? ""}${host ? "'0.0.0.0'" : ""}`,
  );

  // const PORT = 3000; … app.listen(PORT …)
  for (const m of content.matchAll(/\.listen\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const name = m[1]!;
    const decl = new RegExp(`\\b(const|let|var)\\s+${name}(\\s*:\\s*number)?\\s*=\\s*(\\d{2,5})\\b`);
    out = out.replace(decl, (_d, kw: string, type = "", port: string) => `${kw} ${name}${type} = Number(process.env.PORT) || ${port}`);
    out = out.replace(new RegExp(`\\.listen\\(\\s*${name}\\s*,\\s*(['"])(?:localhost|127\\.0\\.0\\.1)\\1`), `.listen(${name}, '0.0.0.0'`);
  }

  // fastify.listen({ port: 3000, host: 'localhost' })
  out = out.replace(/\.listen\(\s*\{([^}]*)\}/g, (whole, inner: string) => {
    let body = inner.replace(/\bport\s*:\s*(\d{2,5})\b/, (_p, port: string) => `port: Number(process.env.PORT) || ${port}`);
    body = body.replace(new RegExp(`\\bhost\\s*:\\s*${LOOPBACK.source}`), "host: '0.0.0.0'");
    if (!/\bhost\s*:/.test(body) && /\bport\s*:/.test(body)) body = body.replace(/\s*$/, (ws) => `, host: '0.0.0.0'${ws}`);
    return body === inner ? whole : `.listen({${body}}`;
  });

  return out === content ? null : out;
}

/** A Node API that listens on a fixed port never answers on the port the host assigns. */
export async function fixPortBinding(ctx: FixContext): Promise<Fix | null> {
  if (ctx.service.type !== "node_api") return null;
  const files: Fix["files"] = [];
  for (const file of await ctx.files.listFiles()) {
    if (!CODE_FILE_RE.test(file) || IGNORED_DIR_RE.test(file) || TEST_FILE_RE.test(file)) continue;
    if (!isUnder(file, ctx.service.rootDir)) continue;
    const before = await ctx.files.readFile(file);
    if (!before) continue;
    const after = bindToPort(before);
    if (after) files.push({ path: file, before, after });
  }
  if (!files.length) return null;
  return {
    id: "port-binding",
    title: "Listen on the port the host assigns",
    explanation: `Hosts like Render tell the app which port to use through the PORT variable and only route traffic there. The server used a fixed port (and sometimes only accepted local connections), so it never received requests. It now uses PORT when set and keeps the old port for local development, in ${files.map((f) => f.path).join(", ")}.`,
    files,
    plan: [],
  };
}

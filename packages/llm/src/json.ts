import type { z } from "zod";

/**
 * Pull a JSON object out of a model response that may be wrapped in ```json
 * fences or surrounded by prose. Returns the JSON substring or null.
 */
export function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Extract + JSON.parse + validate against a Zod schema in one pass. This is the
 * choke point that forces model output into a contract: anything that doesn't
 * conform comes back as `{ ok: false }` with a human-readable error the caller
 * can feed into a repair prompt.
 */
export function parseStructured<S extends z.ZodTypeAny>(
  text: string,
  schema: S,
): ParseResult<z.infer<S>> {
  const json = extractJsonBlock(text);
  if (json == null) return { ok: false, error: "No JSON object found in model output." };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error };
  }
  return { ok: true, data: parsed.data };
}

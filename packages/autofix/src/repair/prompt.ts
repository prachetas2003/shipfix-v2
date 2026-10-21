import { z } from "zod";
import type { LogDiagnosis } from "@shipfix/adapter-core";
import type { LLMRequest } from "@shipfix/llm";
import type { FixService } from "../types";
import type { ContextFile } from "./context";

export const RepairResponse = z.object({
  /** Plain-English root cause, written for the pull request. */
  explanation: z.string().min(1).max(1200),
  canFix: z.boolean(),
  /** When canFix is false: what only the user can provide (a secret, an external service, a decision). */
  needsFromUser: z.string().max(600).optional(),
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        find: z.string().optional(),
        replace: z.string(),
      }),
    )
    .max(8)
    .default([]),
});
export type RepairResponse = z.infer<typeof RepairResponse>;

export interface PriorAttempt {
  summary: string;
  result: string;
}

const SYSTEM = `You are ShipFix's repair engineer. A deploy of the user's app failed on a hosting provider. Find the root cause and make the smallest code change that fixes it.

Rules:
- Fix the cause, not the symptom. Never silence errors: do not disable type checking, set ignoreBuildErrors, add @ts-ignore/@ts-nocheck, delete failing code, or skip the build.
- Keep behavior identical apart from the fix. Match the surrounding code style.
- Never add secrets, API keys, or credentials. Never edit lockfiles, .env files, or CI config.
- If the fix needs something only the user can provide (a secret value, an external service, a product decision), set "canFix": false and say what is needed in "needsFromUser".
- Edits use exact text replacement: "find" must be copied verbatim from the file shown (including whitespace) and must occur exactly once. Omit "find" only to create a new file.
- Paths are relative to the repository root, exactly as shown.

Respond with JSON only:
{"explanation": string, "canFix": boolean, "needsFromUser"?: string, "edits": [{"path": string, "find"?: string, "replace": string}]}`;

export function buildRepairRequest(args: {
  service: FixService;
  diagnosis: LogDiagnosis;
  logTail: string;
  files: ContextFile[];
  prior: PriorAttempt[];
}): LLMRequest {
  const { service, diagnosis } = args;
  const parts = [
    `## Service\nid: ${service.id}\ntype: ${service.type}\nhost: ${service.provider}\nroot directory: ${service.rootDir || "(repo root)"}\ninstall: ${service.install ?? "(none)"}\nbuild: ${service.build ?? "(none)"}\nstart: ${service.start ?? "(none)"}`,
    `## Failure\nphase: ${diagnosis.phase}\nkind: ${diagnosis.kind}\n${diagnosis.title}${diagnosis.subject ? `\nsubject: ${diagnosis.subject}` : ""}`,
    `## Log (last lines)\n\`\`\`\n${args.logTail}\n\`\`\``,
  ];
  if (args.prior.length) {
    parts.push(
      `## Earlier attempts that did not work\n${args.prior.map((p, i) => `${i + 1}. ${p.summary}\n   Result: ${p.result}`).join("\n")}`,
    );
  }
  parts.push(
    `## Files\n${args.files
      .map((f) => `### ${f.path}${f.truncated ? " (truncated)" : ""}\n\`\`\`\n${f.content}\n\`\`\``)
      .join("\n\n")}`,
  );
  return { system: SYSTEM, user: parts.join("\n\n"), maxOutputTokens: 8000, temperature: 0 };
}

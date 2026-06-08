import type { RepoContext } from "@shipfix/contracts";

/** Keep the prompt bounded: a huge file tree shouldn't blow the token budget. */
const MAX_TREE_IN_PROMPT = 250;
const MAX_PROMPT_CHARS = Number(process.env.LLM_MAX_PROMPT_CHARS ?? 60_000);
const SENSITIVE_FILE_RE = /(^|\/)(\.env($|\.)|.*\.pem$|.*\.key$|id_rsa$|id_ed25519$|.*secret.*|.*credential.*)/i;
const LOW_SIGNAL_FILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;

function promptSafeFile(file: string): boolean {
  return !SENSITIVE_FILE_RE.test(file) && !LOW_SIGNAL_FILE_RE.test(file);
}

/**
 * The system prompt. Encodes ShipFix's identity (a deployment operator, NOT a
 * code fixer), the hard grounding rules, classification semantics, and the
 * exact DeploymentPlan JSON contract the model must emit.
 */
export function buildSystemPrompt(): string {
  return `You are ShipFix, an AI-assisted DEPLOYMENT OPERATOR.

Your only job: turn deterministic repository evidence (a RepoContext) into a
single DeploymentPlan describing how to deploy the app. You PROPOSE a plan;
deterministic code will validate it and can override or downgrade it.

You are NOT a code-writing or feature-building agent. You do not fix application
logic, refactor, execute commands, deploy, or modify the repository. You only
produce a plan.

HARD RULES (violations make the plan invalid):
- Ground every claim in the provided RepoContext. Do NOT invent services,
  directories, files, package scripts, env var names, providers, or wiring.
- Every service's rootDir MUST be a rootDir present in RepoContext.services (or
  "" for the repo root). Build/install/start commands SHOULD use scripts that
  exist in that service's scripts map (e.g. "npm run build" requires a "build"
  script).
- Reference environment variables by NAME only. Never include secret values.
- For backend services, set healthCheckPath and verification checks from
  routeCandidates in RepoContext.services (highest-scored GET path, especially
  health/readiness names). Prefer check "health_path" with an explicit target
  over bare "http_2xx". Do NOT invent routes that are not in routeCandidates.
- If routeCandidates is empty for a backend, you may still propose a path but
  validation will mark it as assumed/unverified — lower confidence accordingly.
- If you are not confident the app can be deployed from the evidence, do NOT
  guess. Use classification "needs_setup" (user input/secrets/choices needed) or
  "diagnose_only" (cannot be safely deployed), and explain via blockers and/or
  questions.

AUTO-DEPLOYABLE SLICE (what ShipFix can actually execute today):
- "vercel" + "frontend_static" (Vite/static frontends)
- "render" + "node_api" (Node/Express-style APIs)
- managed "neon" + "postgres"
ONLY these provider+type combinations may be classification "deployable".

EVERYTHING ELSE IS DIAGNOSIS-ONLY. If the app needs anything outside the slice
above — "frontend_ssr", "python_api", "worker", "docker_service", "railway",
"supabase", "upstash", redis, object storage, Next.js full-stack, Docker-only
apps, non-JS stacks — you MUST set classification "diagnose_only" and explain it
with blockers. Do NOT propose a "deployable" plan for unsupported stacks; the
validator will force it to RED anyway, so be honest up front. You may still
describe the unsupported service for diagnosis, but never imply ShipFix will
deploy it.

The schema enums below intentionally include unsupported values so you can
describe them for DIAGNOSIS — listing one does NOT mean ShipFix can deploy it.

If the app needs database migrations, keep them out of scope: ShipFix
provisions the database but does NOT run migrations. Note this as a blocker and
prefer "needs_setup".

ENV WIRING:
- "generated_from_service": ref "serviceId.publicUrl" or "serviceId.origin".
- "generated_from_managed": ref "managedId.connectionUrl".
- "provider_injected": platform-provided (e.g. PORT).
- "user_secret": the user must supply it — also add a matching question.
- "literal": only for known NON-secret defaults (never a credential).
- Add a wiring edge for each generated env var.

OUTPUT FORMAT:
Return ONLY a single JSON object — no markdown, no code fences, no commentary —
matching this DeploymentPlan schema exactly:

{
  "goal": string,
  "classification": "deployable" | "needs_setup" | "diagnose_only",
  "services": [{
    "id": string,                         // unique; referenced by wiring/deployOrder
    "type": "frontend_static"|"frontend_ssr"|"node_api"|"python_api"|"worker"|"docker_service",
    "provider": "vercel"|"render"|"railway",
    "rootDir": string,
    "install": string|null,
    "build": string|null,
    "start": string|null,
    "outputDir": string|null,             // static frontends only
    "healthCheckPath": string|null,       // backends only
    "env": [{ "name": string, "source": "user_secret"|"generated_from_service"|"generated_from_managed"|"provider_injected"|"literal", "ref"?: string, "value"?: string }],
    "evidence": string[]                  // RepoContext file paths that justify this
  }],
  "managed": [{
    "id": string,
    "kind": "postgres"|"redis"|"object_storage",
    "mode": "provision"|"connect_existing",
    "provider"?: "neon"|"supabase"|"upstash",
    "exposesEnv": string,                 // e.g. "DATABASE_URL"
    "migration": "prisma"|"drizzle"|"django"|"alembic"|"none"
  }],
  "wiring": [{ "fromServiceId": string, "fromField": "publicUrl"|"connectionUrl"|"origin", "toServiceId": string, "toEnvName": string }],
  "deployOrder": string[],                // every service id AND managed id, topologically ordered
  "questions": [{ "id": string, "prompt": string, "kind": "secret"|"choice"|"confirm", "options"?: string[], "default"?: string, "blocksServiceIds": string[] }],
  "blockers": [{ "severity": "fatal"|"needs_input"|"warning", "title": string, "explanation": string, "action": string, "autoFixable": boolean, "evidence": string[] }],
  "verification": [{ "serviceId": string, "check": "http_2xx"|"health_path"|"frontend_loads"|"cors_from"|"db_connect", "target"?: string }],
  "confidence": number                    // 0..1, your honest confidence
}`;
}

/** Compact, prompt-friendly projection of RepoContext (already secret-free). */
function summarizeRepoContext(ctx: RepoContext): string {
  const safeTree = ctx.fileTree.filter(promptSafeFile);
  const tree = safeTree.slice(0, MAX_TREE_IN_PROMPT);
  const truncated = safeTree.length - tree.length;
  return JSON.stringify(
    {
      repoFullName: ctx.repoFullName,
      commitSha: ctx.commitSha,
      monorepoTool: ctx.monorepoTool,
      services: ctx.services,
      dataNeeds: ctx.dataNeeds,
      envRefs: ctx.envRefs,
      hardcodedUrls: ctx.hardcodedUrls,
      fileTree: tree,
      excludedSensitiveOrLowSignalFileCount: ctx.fileTree.length - safeTree.length,
      fileTreeTruncatedCount: truncated > 0 ? truncated : undefined,
      alphaPromptLimit:
        ctx.fileTree.length > safeTree.length || truncated > 0
          ? "Some files were excluded or truncated for alpha safety. ShipFix never sends .env files, private keys, lockfiles, or huge file trees to the model."
          : undefined,
    },
    null,
    2,
  );
}

/** The user message: the evidence plus the instruction to plan. */
export function buildUserPrompt(ctx: RepoContext): string {
  const prompt = `Here is the deterministic RepoContext evidence for the repository.
Produce the DeploymentPlan JSON for it now.

RepoContext:
${summarizeRepoContext(ctx)}`;
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_PROMPT_CHARS)}

[TRUNCATED_FOR_ALPHA_PROMPT_LIMIT: Repo evidence exceeded ${MAX_PROMPT_CHARS} characters. Do not infer missing files; classify as needs_setup or diagnose_only if required evidence is absent.]`;
}

/** A follow-up message asking the model to fix schema-invalid output. */
export function buildRepairPrompt(originalUser: string, badOutput: string, errors: string): string {
  return `Your previous response was not valid against the DeploymentPlan schema.

Validation errors:
${errors}

Your previous output was:
${badOutput}

Return ONLY corrected JSON that matches the schema exactly — no commentary, no
code fences. The original task was:

${originalUser}`;
}

import type { DeployInput } from "@shipfix/adapter-core";
import { VERCEL_SSR_PRESETS } from "@shipfix/contracts";

/**
 * Vercel framework preset for the service. SSR frameworks build/serve
 * themselves; null means "Other" (the build emits .vercel/output itself).
 * SSR plans persisted before `framework` existed are Next.js.
 */
export function frameworkPreset(input: DeployInput): string | null {
  if (input.service.type !== "frontend_ssr") return "vite";
  const framework = input.service.framework ?? "next";
  return Object.prototype.hasOwnProperty.call(VERCEL_SSR_PRESETS, framework)
    ? VERCEL_SSR_PRESETS[framework]!
    : "nextjs";
}

/**
 * Env the build needs on Vercel beyond the plan's own: Nitro-based apps with
 * no Vercel preset must be told to emit the Build Output API. A value the
 * user set wins.
 */
export function vercelBuildEnv(input: DeployInput): Record<string, string> {
  if (input.service.type === "frontend_ssr" && frameworkPreset(input) === null && !("NITRO_PRESET" in input.env)) {
    return { ...input.env, NITRO_PRESET: "vercel" };
  }
  return input.env;
}

export function buildProjectBody(input: DeployInput, name: string): Record<string, unknown> {
  return {
    name,
    framework: frameworkPreset(input),
    gitRepository: { type: "github", repo: input.repo.fullName },
    rootDirectory: input.rootDir || undefined,
    installCommand: input.service.install ?? undefined,
    buildCommand: input.service.build ?? undefined,
    // SSR output is managed by the framework preset; never override it.
    outputDirectory:
      input.service.type === "frontend_ssr" ? undefined : input.service.outputDir ?? undefined,
  };
}

export function buildProjectPatch(input: DeployInput): Record<string, unknown> {
  return {
    framework: frameworkPreset(input),
    rootDirectory: input.rootDir || undefined,
    installCommand: input.service.install ?? undefined,
    buildCommand: input.service.build ?? undefined,
    // Clear an output dir left over from an earlier static deploy of the project.
    outputDirectory:
      input.service.type === "frontend_ssr" ? null : input.service.outputDir ?? undefined,
  };
}

import type { DeployInput } from "@shipfix/adapter-core";

/** Vercel framework preset for the service type. Next builds/serves itself. */
export function frameworkPreset(input: DeployInput): string {
  return input.service.type === "frontend_ssr" ? "nextjs" : "vite";
}

export function buildProjectBody(input: DeployInput, name: string): Record<string, unknown> {
  return {
    name,
    framework: frameworkPreset(input),
    gitRepository: { type: "github", repo: input.repo.fullName },
    rootDirectory: input.rootDir || undefined,
    installCommand: input.service.install ?? undefined,
    buildCommand: input.service.build ?? undefined,
    // Next.js output is managed by Vercel; never override it for SSR.
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
    outputDirectory:
      input.service.type === "frontend_ssr" ? undefined : input.service.outputDir ?? undefined,
  };
}

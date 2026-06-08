import type { DeployInput } from "@shipfix/adapter-core";

export function buildProjectBody(input: DeployInput, name: string): Record<string, unknown> {
  return {
    name,
    framework: "vite",
    gitRepository: { type: "github", repo: input.repo.fullName },
    rootDirectory: input.rootDir || undefined,
    installCommand: input.service.install ?? undefined,
    buildCommand: input.service.build ?? undefined,
    outputDirectory: input.service.outputDir ?? undefined,
  };
}

export function buildProjectPatch(input: DeployInput): Record<string, unknown> {
  return {
    rootDirectory: input.rootDir || undefined,
    installCommand: input.service.install ?? undefined,
    buildCommand: input.service.build ?? undefined,
    outputDirectory: input.service.outputDir ?? undefined,
  };
}

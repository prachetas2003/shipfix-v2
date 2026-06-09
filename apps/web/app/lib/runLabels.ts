export function runStatusLabel(mode: string, status: string): string {
  if (mode === "plan" && status === "succeeded") return "Plan ready";
  if (mode === "deploy" && status === "succeeded") return "Deploy succeeded";
  if (mode === "deploy" && status === "failed") return "Deploy failed";
  if (mode === "deploy" && status === "diagnosed") return "Deploy needs attention";
  if (mode === "plan" && status === "failed") return "Plan failed";
  if (mode === "plan") return `Plan ${status}`;
  return status;
}

export function runModeLabel(mode: string): string {
  if (mode === "plan") return "Plan run";
  if (mode === "deploy") return "Deploy run";
  if (mode === "analyze_only") return "Analysis run";
  return mode;
}

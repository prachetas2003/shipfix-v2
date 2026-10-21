export interface PullRequestFix {
  serviceId: string;
  title: string;
  explanation: string;
  /** False when the sandbox build stopped only on settings it never has (secrets). */
  fullyVerified: boolean;
  files: Array<{ path: string; created: boolean }>;
}

export const SHIPFIX_FOOTER = "Fixed by ShipFix";

export function pullRequestTitle(fixes: PullRequestFix[]): string {
  return fixes.length === 1 ? `ShipFix: ${fixes[0]!.title}` : `ShipFix: fix ${fixes.length} deploy problems`;
}

/**
 * The PR body a non-expert can review: what broke, what changed, how it was
 * tested, and how to back out. The diff itself is in GitHub's "Files changed" tab.
 */
export function pullRequestBody(args: { fixes: PullRequestFix[]; baseBranch: string; repairBranch: string }): string {
  const sections: string[] = [];
  sections.push(
    `Your deploy failed, so ShipFix found the cause, changed the code, and tested the change before opening this pull request. Your app is currently deployed from \`${args.repairBranch}\`.`,
  );

  sections.push(
    `## What was wrong\n\n${args.fixes
      .map((f) => (args.fixes.length > 1 ? `**${f.title}** (\`${f.serviceId}\`)\n\n${f.explanation}` : f.explanation))
      .join("\n\n")}`,
  );

  const files = new Map<string, boolean>();
  for (const f of args.fixes.flatMap((x) => x.files)) files.set(f.path, (files.get(f.path) ?? false) || f.created);
  sections.push(`## What changed\n\n${[...files].map(([p, created]) => `- \`${p}\`${created ? " (new file)" : ""}`).join("\n")}`);

  const partial = args.fixes.filter((f) => !f.fullyVerified);
  sections.push(
    `## How it was tested\n\nShipFix installed and built the app with these changes in an isolated sandbox, using the same commands as your host.${
      partial.length
        ? ` For ${partial.map((f) => `\`${f.serviceId}\``).join(", ")}, the build got past the original error and then stopped only on settings the sandbox never receives (like secrets); the real deploy uses your actual settings.`
        : " The build passed."
    }`,
  );

  sections.push(
    `## Keeping or undoing it\n\n- **Merge** to keep the fix. Future deploys from \`${args.baseBranch}\` will include it.\n- **Close** to reject it. Your next deploy goes back to \`${args.baseBranch}\` as it is, and the original error will come back.`,
  );

  sections.push(`---\n${SHIPFIX_FOOTER}`);
  return sections.join("\n\n");
}

/** Commit message: summary line, a blank line, then the plain-English cause. */
export function commitMessage(fixes: PullRequestFix[]): string {
  const summary = fixes.length === 1 ? fixes[0]!.title : `Fix ${fixes.length} deploy problems`;
  const body = fixes.map((f) => (fixes.length > 1 ? `${f.title} (${f.serviceId}): ${f.explanation}` : f.explanation)).join("\n\n");
  return `${summary}\n\n${body}\n\n${SHIPFIX_FOOTER}`;
}

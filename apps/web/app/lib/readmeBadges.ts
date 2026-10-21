/** Markdown a repo README can paste. `origin` is the ShipFix web origin, with no trailing slash. */
export function readmeMarkdown(origin: string): { button: string; badge: string } {
  const base = origin.replace(/\/$/, "");
  return {
    button: `[![Deploy with ShipFix](${base}/deploy-button.svg)](${base}/new)`,
    badge: `[![Deployed and checked by ShipFix](${base}/badge.svg)](${base})`,
  };
}

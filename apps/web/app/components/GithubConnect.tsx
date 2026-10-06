"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { colors } from "../lib/theme";
import { Button } from "./ui";

type Info = Awaited<ReturnType<typeof api.listGithubInstallations>>;

/** Private-repo access: install the ShipFix GitHub App, or show which accounts are linked. */
export function GithubConnect(): React.ReactElement | null {
  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    api.listGithubInstallations().then(setInfo).catch(() => setInfo(null));
  }, []);

  if (!info?.configured || !info.installUrl) return null;
  const linked = info.installations.map((i) => i.accountLogin).filter(Boolean);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        marginTop: "0.9rem",
        fontSize: "0.86rem",
        color: colors.dim,
      }}
    >
      <span>
        {linked.length
          ? `Private repos enabled for ${linked.join(", ")}.`
          : "Deploying a private repo? Install the ShipFix GitHub App first."}
      </span>
      {info.claimable && (
        <a href={info.installUrl} style={{ textDecoration: "none" }}>
          <Button variant="ghost">{linked.length ? "Add GitHub account" : "Connect GitHub"}</Button>
        </a>
      )}
    </div>
  );
}

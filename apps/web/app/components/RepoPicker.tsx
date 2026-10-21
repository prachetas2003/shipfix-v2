"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { colors, mono } from "../lib/theme";

type Repo = { fullName: string; private: boolean; defaultBranch: string };

/** Repos from GitHub accounts this user has connected. Empty when the app is not installed. */
export function RepoPicker({
  onPick,
  disabled,
}: {
  onPick: (fullName: string) => void;
  disabled?: boolean;
}): React.ReactElement | null {
  const [repos, setRepos] = useState<Repo[] | null>(null);

  useEffect(() => {
    api
      .listGithubRepos()
      .then((r) => setRepos(r.configured ? r.repos : []))
      .catch(() => setRepos([]));
  }, []);

  if (!repos || repos.length === 0) return null;

  return (
    <div style={{ marginTop: "0.9rem" }}>
      <p style={{ margin: "0 0 0.45rem", fontSize: "0.82rem", color: colors.dim }}>Pick a repository</p>
      <div style={{ display: "grid", gap: 6, maxHeight: 240, overflow: "auto" }}>
        {repos.map((repo) => (
          <button
            key={repo.fullName}
            type="button"
            disabled={disabled}
            onClick={() => onPick(repo.fullName)}
            style={{
              textAlign: "left",
              background: colors.panelSoft,
              color: colors.text,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: "0.5rem 0.7rem",
              cursor: disabled ? "default" : "pointer",
              fontFamily: mono,
              fontSize: "0.82rem",
            }}
          >
            {repo.fullName}
            {repo.private ? <span style={{ color: colors.dim, fontFamily: "inherit" }}> · private</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

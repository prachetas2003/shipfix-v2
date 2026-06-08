import { describe, it, expect } from "vitest";
import {
  buildGitSource,
  formatRepoIdUnresolvedError,
  linkMatchesRepo,
  normalizeRepoSlug,
  repoIdFromLink,
  repoSlugFromLink,
  repoSlugFromSearchEntry,
  repoSlugMatches,
} from "../src/vercelGit";

describe("vercelGit helpers", () => {
  it("normalizes GitHub slugs for comparison", () => {
    expect(normalizeRepoSlug("https://github.com/Acme/App.git")).toBe("acme/app");
    expect(repoSlugMatches("Acme/App", "acme/app")).toBe(true);
  });

  it("extracts repoId from project link", () => {
    expect(repoIdFromLink({ repoId: 12345 })).toBe("12345");
    expect(repoIdFromLink({ repoId: "67890" })).toBe("67890");
    expect(repoIdFromLink(undefined)).toBeNull();
  });

  it("builds gitSource with repoId and optional sha", () => {
    expect(buildGitSource("12345", "main")).toEqual({
      type: "github",
      repoId: "12345",
      ref: "main",
    });
    expect(buildGitSource("12345", "main", "abc")).toEqual({
      type: "github",
      repoId: "12345",
      ref: "main",
      sha: "abc",
    });
    expect(buildGitSource("12345", "main")).not.toHaveProperty("repo");
  });

  it("derives slug from search-repo entries", () => {
    expect(repoSlugFromSearchEntry({ owner: "acme", slug: "app", id: 1 })).toBe("acme/app");
  });

  it("derives slug from org/repo link fields", () => {
    expect(repoSlugFromLink({ org: "acme", repo: "app" })).toBe("acme/app");
    expect(linkMatchesRepo({ org: "acme", repo: "app", repoId: 1 }, "acme/app")).toBe(true);
  });

  it("formats unresolved repoId errors", () => {
    expect(formatRepoIdUnresolvedError("prj_x", "acme/app")).toContain("prj_x");
    expect(formatRepoIdUnresolvedError("prj_x", "acme/app")).toContain("acme/app");
  });
});

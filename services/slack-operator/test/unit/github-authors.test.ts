import { describe, expect, it } from "vitest";

import { githubAuthorSurface } from "../../src/github-authors.js";

describe("github author surface — served, not recomputed", () => {
  it("copies the concentration warning fields and does not invent an author", () => {
    const surface = githubAuthorSurface({
      warnings: [{
        code: "github_author_concentration",
        severity: "warning",
        openClaims: 4,
        totalOpenClaims: 6,
        distinctWallets: 2,
      }],
    });
    expect(surface.warning).toEqual({
      code: "github_author_concentration",
      severity: "warning",
      message: null,
      openClaims: 4,
      totalOpenClaims: 6,
      distinctWallets: 2,
    });
    expect(surface.block).toBeNull();
    expect(JSON.stringify(surface)).not.toContain("unmerged");
  });

  it("renders the admin githubAuthors block without recounting", () => {
    const surface = githubAuthorSurface({
      adminStatus: {
        githubAuthors: {
          distinctAuthors: 2,
          distinctWallets: 3,
          unattributedClaims: 1,
          unattributedSessions: 0,
          authors: [{
            author: "worker",
            openClaims: 4,
            submitted: 2,
            awaitingHumanReview: 1,
            settled7d: 0,
            settled30d: 3,
            distinctWallets: 2,
            usdcPaid: { amount: "1.5" },
          }],
          warnings: [{
            code: "github_author_concentration",
            severity: "warning",
            openClaims: 4,
            totalOpenClaims: 6,
            distinctWallets: 2,
          }],
        },
      },
    });
    expect(surface.block?.distinctAuthors).toBe(2);
    expect(surface.block?.authors[0]).toMatchObject({ author: "worker", openClaims: 4, usdcPaid: "1.5" });
    expect(surface.warning?.openClaims).toBe(4);
  });

  it("prefers the /health warning over the admin copy of the same code", () => {
    const surface = githubAuthorSurface({
      warnings: [{ code: "github_author_concentration", severity: "warning", openClaims: 9, totalOpenClaims: 10, distinctWallets: 1, message: "from health" }],
      adminStatus: {
        githubAuthors: {
          distinctAuthors: 1,
          warnings: [{ code: "github_author_concentration", openClaims: 1, totalOpenClaims: 1, distinctWallets: 1 }],
        },
      },
    });
    expect(surface.warning?.openClaims).toBe(9);
    expect(surface.warning?.message).toBe("from health");
  });
});

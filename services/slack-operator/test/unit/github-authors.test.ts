import { afterEach, describe, expect, it } from "vitest";

import { __resetGithubAuthorsForTests, githubAuthorSurface, readAdminGithubAuthors } from "../../src/github-authors.js";

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

  it("does not treat the whole admin status body as the authors block", () => {
    const surface = githubAuthorSurface({
      adminStatus: { distinctAuthors: 4, authors: [{ author: "worker", openClaims: 1 }] },
    });
    expect(surface.block).toBeNull();
    expect(surface.unavailable).toBe("missing");
  });

  it("a missing count stays null, so num() returning 0 fails this test", () => {
    const surface = githubAuthorSurface({
      adminStatus: { githubAuthors: { authors: [{ author: "worker" }] } },
    });
    expect(surface.block?.distinctAuthors).toBeNull();
    expect(surface.block?.authors[0]?.openClaims).toBeNull();
    expect(surface.block?.authors[0]?.openClaims).not.toBe(0);
    expect(surface.block?.authors[0]?.missingPayoutEvidence).toBeNull();
  });
});

describe("readAdminGithubAuthors", () => {
  afterEach(() => __resetGithubAuthorsForTests());

  const blockBody = {
    githubAuthors: {
      distinctAuthors: 2,
      authors: [{ author: "worker", openClaims: 1, usdcPaid: { amount: "1.5" }, missingPayoutEvidence: null }],
    },
  };

  it("polls /admin/status no more than every 5 minutes", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => blockBody };
    }) as typeof fetch;
    const input = {
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl,
      minIntervalMs: 5 * 60 * 1000,
    };
    await readAdminGithubAuthors({ ...input, nowMs: 0 });
    await readAdminGithubAuthors({ ...input, nowMs: 60_000 });
    expect(calls).toBe(1);
    await readAdminGithubAuthors({ ...input, nowMs: 5 * 60 * 1000 });
    expect(calls).toBe(2);
  });

  it("a timeout keeps the last block and its age", async () => {
    const ok = (async () => ({ ok: true, status: 200, json: async () => blockBody })) as typeof fetch;
    const first = await readAdminGithubAuthors({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: ok,
      nowMs: 1_000,
      minIntervalMs: 0,
    });
    expect(first.block?.distinctAuthors).toBe(2);

    const hung = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return { ok: false, status: 500, json: async () => ({}) };
    }) as typeof fetch;
    const second = await readAdminGithubAuthors({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: hung,
      nowMs: 20_000,
      timeoutMs: 20,
      minIntervalMs: 0,
    });
    expect(second.block?.distinctAuthors).toBe(2);
    expect(second.stale).toBe(true);
    expect(second.unavailable).toBe("timeout");
    expect(second.ageMs).toBe(19_000);
  });

  it("an unauthorised read is not a block of zeros", async () => {
    const surface = await readAdminGithubAuthors({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as typeof fetch,
      nowMs: 5_000,
      minIntervalMs: 0,
    });
    expect(surface.block).toBeNull();
    expect(surface.unavailable).toBe("unauthorised");
  });
});

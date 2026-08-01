import { describe, expect, it } from "vitest";

import { decideSelfFreshness, fetchSelfCompare } from "../../services/slack-operator/src/self-freshness.js";

const NOW = Date.parse("2026-07-29T18:00:00Z");
const SHA = "824ae4c1f2d3b4a5968778695a4b3c2d1e0f9a8b";

function ago(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

// A DIRTY build is its own state, and the most dangerous one: it HAS a sha, so
// a naive compare would answer "0 behind → up to date" for code that exists in
// no commit anywhere. An un-popped stash on the VPS once silently reverted a
// built asset while everything downstream reported healthy.
describe("decideSelfFreshness — dirty builds", () => {
  it("never claims up-to-date, even when the sha compares clean", () => {
    const r = decideSelfFreshness({
      runningSha: "abcdef1234567890",
      compare: { behindBy: 0 },
      dirty: true,
      nowMs: 0,
    });
    expect(r.status).toBe("unknown");
    expect(r.status).not.toBe("current");
    expect(r.detail).toContain("uncommitted changes");
    expect(r.behindBy).toBeNull();
  });

  it("keeps the sha visible so the operator knows the base commit", () => {
    const r = decideSelfFreshness({
      runningSha: "abcdef1234567890",
      compare: null,
      dirty: true,
      nowMs: 0,
    });
    expect(r.runningSha).toBe("abcdef1234567890");
    expect(r.detail).toContain("abcdef12");
  });

  it("a dirty build with no sha at all still reads unknown", () => {
    const r = decideSelfFreshness({ runningSha: null, compare: null, dirty: true, nowMs: 0 });
    expect(r.status).toBe("unknown");
    expect(r.detail).toContain("uncommitted changes");
  });

  it("clean builds are unaffected — dirty defaults to false", () => {
    const r = decideSelfFreshness({
      runningSha: "abcdef1234567890",
      compare: { behindBy: 0 },
      nowMs: 0,
    });
    expect(r.status).toBe("current");
  });
});

describe("decideSelfFreshness", () => {
  // THE REAL INCIDENT: the VPS sat 6 commits behind main and nothing said so.
  it("names how far behind it is and how long it has been stale", () => {
    const r = decideSelfFreshness({
      runningSha: SHA,
      compare: { behindBy: 6, oldestUnshippedAt: ago(9) },
      nowMs: NOW,
    });
    expect(r.status).toBe("behind");
    expect(r.behindBy).toBe(6);
    expect(r.detail).toContain("6 commits behind main");
    expect(r.detail).toContain("oldest merged 9h ago");
    expect(r.detail).toContain("merged work is not live");
  });

  it("an up-to-date build says so plainly", () => {
    const r = decideSelfFreshness({ runningSha: SHA, compare: { behindBy: 0 }, nowMs: NOW });
    expect(r.status).toBe("current");
    expect(r.detail).toBe("824ae4c1 · up to date with main");
  });

  // The three "not good news" states must stay distinguishable.
  it("an UNBAKED sha is unknown and names the build arg, never 'up to date'", () => {
    for (const sha of [null, "", "   ", "unknown", "UNKNOWN", "not-a-sha"]) {
      const r = decideSelfFreshness({ runningSha: sha, compare: { behindBy: 0 }, nowMs: NOW });
      expect(r.status).toBe("unknown");
      expect(r.detail).toContain("GIT_SHA");
      expect(r.behindBy).toBeNull();
    }
  });

  it("a FAILED comparison is unknown — a rate limit must not read as a clean deploy", () => {
    const r = decideSelfFreshness({
      runningSha: SHA,
      compare: null,
      unknownReason: "GitHub compare failed (HTTP 403)",
      nowMs: NOW,
    });
    expect(r.status).toBe("unknown");
    expect(r.detail).toContain("824ae4c1 running");
    expect(r.detail).toContain("HTTP 403");
    expect(r.behindBy).toBeNull();
  });

  it("a very fresh commit drops the age rather than saying '0h ago'", () => {
    const r = decideSelfFreshness({
      runningSha: SHA,
      compare: { behindBy: 1, oldestUnshippedAt: ago(0.2) },
      nowMs: NOW,
    });
    expect(r.detail).toContain("1 commit behind main");
    expect(r.detail).not.toContain("ago");
  });

  it.each([
    [30, "1d ago"],
    [72, "3d ago"],
  ])("ages beyond a day read in days (%ih)", (h, expected) => {
    expect(decideSelfFreshness({
      runningSha: SHA, compare: { behindBy: 2, oldestUnshippedAt: ago(h) }, nowMs: NOW,
    }).detail).toContain(expected);
  });

  it("an unparseable timestamp drops the age instead of reporting 1970", () => {
    const r = decideSelfFreshness({
      runningSha: SHA, compare: { behindBy: 3, oldestUnshippedAt: "not-a-date" }, nowMs: NOW,
    });
    expect(r.status).toBe("behind");
    expect(r.detail).not.toContain("ago");
  });

  it("a negative behind_by clamps to current rather than going nonsense", () => {
    expect(decideSelfFreshness({ runningSha: SHA, compare: { behindBy: -3 }, nowMs: NOW }).status).toBe("current");
  });
});

describe("fetchSelfCompare", () => {
  function ok(body: unknown): typeof fetch {
    return (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
  }

  it("reads behind_by and the oldest missing commit", async () => {
    const { compare } = await fetchSelfCompare({
      repo: "depre-dev/averray-reference-agent",
      runningSha: SHA,
      fetchFn: ok({
        behind_by: 6,
        commits: [
          { commit: { committer: { date: "2026-07-29T09:00:00Z" } } },
          { commit: { committer: { date: "2026-07-29T15:00:00Z" } } },
        ],
      }),
    });
    expect(compare).toEqual({ behindBy: 6, oldestUnshippedAt: "2026-07-29T09:00:00Z" });
  });

  it.each([[403, "rate limited"], [404, "private repo without a token"], [500, "upstream"]])(
    "HTTP %i yields null + a reason, never a zero that reads as current",
    async (status) => {
      const r = await fetchSelfCompare({
        repo: "r/r", runningSha: SHA,
        fetchFn: (async () => ({ ok: false, status, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
      });
      expect(r.compare).toBeNull();
      expect(r.reason).toContain(String(status));
    },
  );

  it("a malformed body is null, not an assumed zero", async () => {
    expect((await fetchSelfCompare({ repo: "r/r", runningSha: SHA, fetchFn: ok({ nope: true }) })).compare).toBeNull();
  });

  it("a throwing fetch is null with the cause", async () => {
    const r = await fetchSelfCompare({
      repo: "r/r", runningSha: SHA,
      fetchFn: (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch,
    });
    expect(r.compare).toBeNull();
    expect(r.reason).toContain("socket hang up");
  });

  it("sends the token when one is configured", async () => {
    let seen: Record<string, string> | undefined;
    await fetchSelfCompare({
      repo: "r/r", runningSha: SHA, token: "t0ken",
      fetchFn: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.headers as Record<string, string>;
        return { ok: true, status: 200, json: async () => ({ behind_by: 0, commits: [] }) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    expect(seen?.authorization).toBe("Bearer t0ken");
  });
});

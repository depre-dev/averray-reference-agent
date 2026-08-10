// The draft queue's contract: a backlog you can act on, never a health reading,
// and "we could not ask" never rendered as "there is nothing waiting".
import { describe, expect, test } from "vitest";

import {
  DEFAULT_QUEUE_REPO,
  QUEUE_LABEL,
  buildSocialQueueLine,
  readSocialQueue,
} from "../../src/social-queue.js";

const ENV = { SOCIAL_QUEUE_ENABLED: "1", GITHUB_TOKEN: "t" } as NodeJS.ProcessEnv;

function issue(number: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title,
    html_url: `https://github.com/averray-agent/agent/issues/${number}`,
    ...extra,
  };
}

function respond(body: unknown, ok = true, status = 200) {
  return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("reading the queue", () => {
  test("open drafts come back oldest first, from the sweep's repo", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return { ok: true, status: 200, json: async () => [issue(4, "passed 500 settled jobs")] };
    }) as unknown as typeof fetch;

    const queue = await readSocialQueue({ env: ENV, fetchImpl });

    expect(queue.state).toBe("live");
    expect(queue.drafts).toEqual([
      { number: 4, title: "passed 500 settled jobs", url: "https://github.com/averray-agent/agent/issues/4" },
    ]);
    expect(seen).toContain(DEFAULT_QUEUE_REPO);
    expect(seen).toContain(`labels=${QUEUE_LABEL}`);
    expect(seen).toContain("state=open");
    expect(seen).toContain("direction=asc");
  });

  test("pull requests on the issues endpoint are never queue items", async () => {
    const fetchImpl = respond([issue(9, "a PR", { pull_request: { url: "p" } })]);

    expect((await readSocialQueue({ env: ENV, fetchImpl })).drafts).toEqual([]);
  });

  test("unarmed is off — an unconfigured deployment stays quiet", async () => {
    const queue = await readSocialQueue({ env: {} as NodeJS.ProcessEnv, fetchImpl: respond([]) });

    expect(queue.state).toBe("off");
    expect(queue.problem).toContain("SOCIAL_QUEUE_ENABLED");
  });

  test("ARMED but untokened is UNREADABLE, never off", async () => {
    // The queue lives under a different GitHub owner than this repo, so the
    // plain GITHUB_TOKEN may not reach it. Reporting that as "off" prints no
    // line, and a missing token becomes indistinguishable from an empty queue —
    // a draft could sit unseen for weeks while every morning said nothing was
    // waiting.
    const queue = await readSocialQueue({
      env: { SOCIAL_QUEUE_ENABLED: "1" } as NodeJS.ProcessEnv,
      fetchImpl: respond([]),
    });

    expect(queue.state).toBe("unreadable");
    expect(queue.problem).toContain("GITHUB_OWNER_TOKENS");
  });

  test("an armed queue with no token still produces a visible line", () => {
    const line = buildSocialQueueLine({
      state: "unreadable",
      drafts: [],
      problem: "no GitHub token resolves for averray-agent/agent — check GITHUB_OWNER_TOKENS",
    });

    expect(line).not.toBeNull();
    expect(line?.tone).toBe("degraded");
  });

  test("the arming flag accepts the same words as the digest flag", async () => {
    for (const flag of ["1", "true", "yes", "on", "ON", "True"]) {
      const queue = await readSocialQueue({
        env: { SOCIAL_QUEUE_ENABLED: flag, GITHUB_TOKEN: "t" } as NodeJS.ProcessEnv,
        fetchImpl: respond([]),
      });
      expect(queue.state, `flag "${flag}" should arm the queue`).toBe("live");
    }
  });

  test("a non-200 is unreadable, never an empty queue", async () => {
    const queue = await readSocialQueue({ env: ENV, fetchImpl: respond([], false, 502) });

    expect(queue.state).toBe("unreadable");
    expect(queue.problem).toContain("502");
  });

  test("a thrown fetch is unreadable rather than taking the digest down", async () => {
    const fetchImpl = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;

    const queue = await readSocialQueue({ env: ENV, fetchImpl });

    expect(queue.state).toBe("unreadable");
    expect(queue.problem).toContain("ETIMEDOUT");
  });

  test("a non-list body is unreadable rather than read as nothing queued", async () => {
    const queue = await readSocialQueue({ env: ENV, fetchImpl: respond({}) });

    expect(queue.state).toBe("unreadable");
  });
});

describe("the line", () => {
  test("a live but empty queue produces NO line — most mornings there is nothing", () => {
    // Printing "0 drafts waiting" daily trains the reader to skip the section
    // that will one day matter.
    expect(buildSocialQueueLine({ state: "live", drafts: [] })).toBeNull();
  });

  test("an off queue produces no line at all", () => {
    expect(buildSocialQueueLine({ state: "off", drafts: [] })).toBeNull();
  });

  test("an UNREADABLE queue always produces a line — silence would look empty", () => {
    const line = buildSocialQueueLine({ state: "unreadable", drafts: [], problem: "HTTP 502" });

    expect(line?.tone).toBe("degraded");
    expect(line?.text).toContain("may be waiting unseen");
  });

  test("one draft reads as one, not as a count", () => {
    const line = buildSocialQueueLine({
      state: "live",
      drafts: [{ number: 4, title: "passed 500 settled jobs", url: "u" }],
    });

    expect(line?.text).toContain("1 draft waiting");
    expect(line?.text).toContain("#4 passed 500 settled jobs");
    expect(line?.tone).toBe("ok");
  });

  test("a long queue lists the first few and counts the rest", () => {
    const drafts = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, url: "u" }));

    const line = buildSocialQueueLine({ state: "live", drafts });

    expect(line?.text).toContain("8 drafts waiting");
    expect(line?.text).toContain("+3 more");
  });

  test("an empty queue and an unreadable one never render the same", () => {
    const empty = buildSocialQueueLine({ state: "live", drafts: [] });
    const broken = buildSocialQueueLine({ state: "unreadable", drafts: [], problem: "x" });

    expect(empty).toBeNull();
    expect(broken).not.toBeNull();
  });
});

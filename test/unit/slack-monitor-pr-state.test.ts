import { describe, expect, it } from "vitest";

import { enrichMonitorWithGithubPrState } from "../../services/slack-operator/src/github-pr-state.js";

describe("monitor GitHub PR state enrichment", () => {
  it("adds live GitHub PR state to matching monitor entries", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithGithubPrState({
      recent: [
        {
          correlationId: "github-pr-123-abc-456",
          repo: "averray-agent/agent",
          pullRequestNumber: 123,
          summary: { finalVerdict: "needs_review" },
        },
      ],
    }, {
      env: { GITHUB_TOKEN: "ghp_readonly" },
      now: new Date("2026-05-16T10:00:00.000Z"),
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_readonly" });
        return new Response(JSON.stringify({
          number: 123,
          title: "Ship monitor state",
          html_url: "https://github.com/averray-agent/agent/pull/123",
          user: { login: "codex" },
          state: "closed",
          merged: true,
          draft: false,
          mergeable_state: "clean",
          head: { sha: "abc123" },
          updated_at: "2026-05-16T09:55:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["https://api.github.com/repos/averray-agent/agent/pulls/123"]);
    expect(monitor.recent?.[0]).toMatchObject({
      summary: {
        finalVerdict: "needs_review",
        currentPullRequest: {
          repo: "averray-agent/agent",
          number: 123,
          state: "closed",
          merged: true,
          draft: false,
          mergeableState: "clean",
          headSha: "abc123",
          checkedAt: "2026-05-16T10:00:00.000Z",
          source: "github_live",
        },
      },
    });
  });

  it("uses owner-specific tokens and leaves entries unchanged without a token", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithGithubPrState({
      recent: [
        { repo: "depre-dev/averray-reference-agent", pullRequestNumber: 88, summary: {} },
        { repo: "unknown-owner/repo", pullRequestNumber: 99, summary: {} },
      ],
    }, {
      env: { GITHUB_OWNER_TOKENS: "depre-dev=owner-token" },
      now: new Date("2026-05-16T10:05:00.000Z"),
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer owner-token" });
        return new Response(JSON.stringify({
          number: 88,
          state: "open",
          draft: false,
          merged: false,
        }), { status: 200 });
      },
    });

    expect(calls).toEqual(["https://api.github.com/repos/depre-dev/averray-reference-agent/pulls/88"]);
    expect(monitor.recent?.[0]).toMatchObject({
      summary: {
        currentPullRequest: {
          repo: "depre-dev/averray-reference-agent",
          number: 88,
          state: "open",
        },
      },
    });
    expect(monitor.recent?.[1]).toEqual({ repo: "unknown-owner/repo", pullRequestNumber: 99, summary: {} });
  });
});

import { describe, expect, it } from "vitest";

import { parseProposeTaskPayload } from "../../services/slack-operator/src/codex-task-request.js";

describe("parseProposeTaskPayload — codex (existing-PR) tasks", () => {
  it("accepts a valid repo + PR + prompt and defaults agent/requester", () => {
    const r = parseProposeTaskPayload({ repo: "averray-agent/agent", pullRequestNumber: 402, prompt: "fix it" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      repo: "averray-agent/agent",
      pullRequestNumber: 402,
      prompt: "fix it",
      agent: "codex",
      requester: "monitor",
    });
  });

  it("coerces a numeric-string PR", () => {
    const r = parseProposeTaskPayload({ repo: "a/b", pullRequestNumber: "402", prompt: "x" });
    expect(r.ok && r.input.pullRequestNumber).toBe(402);
  });

  it("rejects codex work with no PR (codex iterates an existing PR)", () => {
    const r = parseProposeTaskPayload({ repo: "a/b", prompt: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/pullRequestNumber.*required.*Codex/i);
  });

  it("rejects a non-positive / non-integer PR", () => {
    expect(parseProposeTaskPayload({ repo: "a/b", pullRequestNumber: 0, prompt: "x" }).ok).toBe(false);
    expect(parseProposeTaskPayload({ repo: "a/b", pullRequestNumber: -3, prompt: "x" }).ok).toBe(false);
  });
});

describe("parseProposeTaskPayload — claude (greenfield) tasks", () => {
  it("accepts greenfield Claude work with NO PR", () => {
    const r = parseProposeTaskPayload({ repo: "averray-agent/agent", agent: "claude", prompt: "build a healthz endpoint" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.agent).toBe("claude");
    expect(r.input.pullRequestNumber).toBeUndefined();
    expect(r.input.prompt).toBe("build a healthz endpoint");
  });

  it("accepts Claude work WITH a valid PR (optional, validated when present)", () => {
    const r = parseProposeTaskPayload({ repo: "a/b", agent: "claude", pullRequestNumber: 7, prompt: "x" });
    expect(r.ok && r.input.pullRequestNumber).toBe(7);
  });

  it("rejects a supplied-but-invalid PR even for Claude", () => {
    const r = parseProposeTaskPayload({ repo: "a/b", agent: "claude", pullRequestNumber: "nope", prompt: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/positive integer/i);
  });

  it("trims whitespace around the agent name", () => {
    const r = parseProposeTaskPayload({ repo: "a/b", agent: " claude ", prompt: "x" });
    expect(r.ok && r.input.agent).toBe("claude");
  });
});

describe("parseProposeTaskPayload — specialist greenfield tasks", () => {
  it("accepts test-writer work with no PR", () => {
    const r = parseProposeTaskPayload({ repo: "averray-agent/agent", agent: "test-writer", prompt: "add parser tests" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.agent).toBe("test-writer");
    expect(r.input.pullRequestNumber).toBeUndefined();
  });
});

describe("parseProposeTaskPayload — rejection paths", () => {
  it("rejects an unknown agent", () => {
    const r = parseProposeTaskPayload({ repo: "a/b", agent: "gpt5", prompt: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/unknown agent "gpt5"/i);
  });

  it("rejects missing repo or prompt", () => {
    expect(parseProposeTaskPayload({ agent: "claude", prompt: "x" }).ok).toBe(false);
    expect(parseProposeTaskPayload({ repo: "a/b", agent: "claude" }).ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(parseProposeTaskPayload(null).ok).toBe(false);
    expect(parseProposeTaskPayload("nope").ok).toBe(false);
    expect(parseProposeTaskPayload([1, 2]).ok).toBe(false);
  });

  it("passes through optional metadata and honors an explicit requester", () => {
    const r = parseProposeTaskPayload({
      repo: "a/b",
      agent: "claude",
      prompt: "x",
      correlationId: "corr-9",
      title: "Add healthz",
      reason: "operator delegated",
      requester: "pkuriger",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      correlationId: "corr-9",
      title: "Add healthz",
      reason: "operator delegated",
      requester: "pkuriger",
    });
  });
});

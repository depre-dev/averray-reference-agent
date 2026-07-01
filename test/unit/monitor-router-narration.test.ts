import { describe, expect, it, vi } from "vitest";

import type { RoutedProposal } from "@avg/averray-mcp/work-router";
import type { HermesSessionConfig, HermesSessionTurn } from "../../services/slack-operator/src/hermes-session-client.js";
import {
  buildHermesRouterAgenticNarrationPrompt,
  buildHermesRouterNarrationPrompt,
  narrateRouterProposal,
  routerNarrationCorrelationId,
  routerProposalFactLines,
  type RouterNarrationDeps,
  type RouterNarrationResult,
  type RouterNarrationTask,
} from "../../services/slack-operator/src/monitor-router-narration.js";

const PROPOSAL: RoutedProposal = {
  taskPrompt: "Add the missing monitor follow-up card renderer.",
  repo: "depre-dev/averray-reference-agent",
  surface: "monitor board",
  agent: "claude",
  riskTier: "low",
  why: "Fills uncovered backlog gap: monitor board.",
  whyAgent: "UI/documentation-shaped work routes to Claude.",
  dedupeKey: "depre-dev/averray-reference-agent|monitor-board|monitor-board",
};

const TASK: RouterNarrationTask = { id: "task-42", correlationId: "corr-42" };

const SESSION_CONFIG: HermesSessionConfig = { baseUrl: "http://gw:8642", apiToken: "tok" };

function fallback(proposal: RoutedProposal, task: RouterNarrationTask): string {
  return `TEMPLATE: routed ${proposal.surface} to ${proposal.agent} as proposed task ${task.id}.`;
}

/** A recorder that captures the single recorded narration. */
function recorder() {
  const calls: Array<RouterNarrationResult & { relatedCorrelationId: string }> = [];
  return {
    record: (r: RouterNarrationResult & { relatedCorrelationId: string }) => {
      calls.push(r);
    },
    calls,
  };
}

function deps(overrides: Partial<RouterNarrationDeps> = {}): RouterNarrationDeps & { calls: ReturnType<typeof recorder>["calls"] } {
  const rec = recorder();
  return {
    fallback,
    sessionConfig: null,
    agenticEnabled: false,
    record: rec.record,
    calls: rec.calls,
    ...overrides,
  };
}

function turn(text: string): HermesSessionTurn {
  return { sessionId: "s1", text };
}

describe("routerProposalFactLines — truth boundary (no fabrication)", () => {
  it("emits a line only for fields that are actually present on the proposal", () => {
    const lines = routerProposalFactLines(PROPOSAL, TASK);
    expect(lines).toContain("Repo: depre-dev/averray-reference-agent");
    expect(lines).toContain("Surface/gap: monitor board");
    expect(lines).toContain("Agent: claude");
    expect(lines).toContain("Risk tier: low");
    expect(lines.some((l) => l.startsWith("Why this gap"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Why this agent"))).toBe(true);
  });

  it("never invents a board signal / rationale the proposal does not carry", () => {
    // A RoutedProposal has no boardSignal field, and whyAgent may be empty for a
    // deterministic route. The builder must stay silent about absent fields.
    const sparse: RoutedProposal = {
      ...PROPOSAL,
      whyAgent: "",
      why: "",
    };
    const lines = routerProposalFactLines(sparse, TASK);
    const joined = lines.join("\n").toLowerCase();
    expect(joined).not.toContain("board signal");
    expect(joined).not.toContain("boardsignal");
    expect(lines.some((l) => l.startsWith("Why this gap"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Why this agent"))).toBe(false);
    // Only the present facts remain.
    expect(lines).toEqual([
      "Task id: task-42",
      "Repo: depre-dev/averray-reference-agent",
      "Surface/gap: monitor board",
      "Agent: claude",
      "Risk tier: low",
    ]);
  });
});

describe("prompt builders thread the real proposal fields + guardrails", () => {
  it("completion prompt carries every present proposal fact and the no-fabrication rules", () => {
    const prompt = buildHermesRouterNarrationPrompt(PROPOSAL, TASK);
    expect(prompt).toContain("depre-dev/averray-reference-agent");
    expect(prompt).toContain("monitor board");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("UI/documentation-shaped work routes to Claude.");
    // truth guardrails present
    expect(prompt).toContain("Describe ONLY the proposal facts listed above");
    expect(prompt).toContain("Never invent a board signal");
    expect(prompt).toContain("PROPOSED ONLY");
    expect(prompt).toContain("one concise, truthful sentence");
  });

  it("agentic prompt threads the same real fields and keeps the guardrails", () => {
    const prompt = buildHermesRouterAgenticNarrationPrompt(PROPOSAL, TASK);
    expect(prompt).toContain("depre-dev/averray-reference-agent");
    expect(prompt).toContain("monitor board");
    expect(prompt).toContain("Fills uncovered backlog gap: monitor board.");
    expect(prompt).toContain("UI/documentation-shaped work routes to Claude.");
    expect(prompt).toContain("your own agentic voice");
    expect(prompt).toContain("Describe ONLY the proposal facts listed above");
    expect(prompt).toContain("Never invent a board signal");
  });

  it("neither prompt mentions a board signal when the proposal has none", () => {
    for (const prompt of [
      buildHermesRouterNarrationPrompt(PROPOSAL, TASK),
      buildHermesRouterAgenticNarrationPrompt(PROPOSAL, TASK),
    ]) {
      // The only occurrences of "signal" are in the guardrails forbidding
      // invention — never a concrete asserted board signal fact line.
      expect(prompt).not.toMatch(/board signal:/i);
      expect(prompt).not.toMatch(/boardSignal/);
    }
  });
});

describe("narrateRouterProposal — agentic path", () => {
  it("uses the agentic session and tags the turn live when the flag is on and it succeeds", async () => {
    const runSession = vi.fn(async () => turn("Proposing a monitor-board card render for Claude; it waits for your approval."));
    const runCompletion = vi.fn(async () => "should-not-be-called");
    const d = deps({ agenticEnabled: true, sessionConfig: SESSION_CONFIG, runSession, runCompletion });

    const result = await narrateRouterProposal(PROPOSAL, TASK, d);

    expect(runSession).toHaveBeenCalledTimes(1);
    // real proposal fields were threaded into the agentic prompt
    const [cfgArg, promptArg] = runSession.mock.calls[0]!;
    expect(cfgArg).toBe(SESSION_CONFIG);
    expect(promptArg).toContain("depre-dev/averray-reference-agent");
    expect(promptArg).toContain("monitor board");
    expect(promptArg).toContain("UI/documentation-shaped work routes to Claude.");
    // the completion transport is never reached once the session produced text
    expect(runCompletion).not.toHaveBeenCalled();

    expect(result.hermesMode).toBe("live");
    expect(result.text).toContain("Proposing a monitor-board card render");
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({ hermesMode: "live", relatedCorrelationId: "corr-42" });
  });

  it("does NOT touch the session when the flag is off (default), even if a config exists", async () => {
    const runSession = vi.fn(async () => turn("live text"));
    const runCompletion = vi.fn(async () => "Completion narration.");
    const d = deps({ agenticEnabled: false, sessionConfig: SESSION_CONFIG, runSession, runCompletion });

    const result = await narrateRouterProposal(PROPOSAL, TASK, d);

    expect(runSession).not.toHaveBeenCalled();
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(result.hermesMode).toBe("live");
    expect(result.text).toBe("Completion narration.");
  });
});

describe("narrateRouterProposal — degraded fallback (session -> completion -> template)", () => {
  it("falls back to the completion when the agentic session returns null", async () => {
    const runSession = vi.fn(async () => null);
    const runCompletion = vi.fn(async () => "Ollama persona narration, proposed and waiting.");
    const d = deps({ agenticEnabled: true, sessionConfig: SESSION_CONFIG, runSession, runCompletion });

    const result = await narrateRouterProposal(PROPOSAL, TASK, d);

    expect(runSession).toHaveBeenCalledTimes(1);
    expect(runCompletion).toHaveBeenCalledTimes(1);
    // the completion got the persona-completion prompt (same facts, no throw)
    expect(runCompletion.mock.calls[0]![0]).toContain("depre-dev/averray-reference-agent");
    expect(result.hermesMode).toBe("live");
    expect(result.text).toBe("Ollama persona narration, proposed and waiting.");
  });

  it("falls back to the completion when the agentic session throws", async () => {
    const runSession = vi.fn(async () => {
      throw new Error("gateway down");
    });
    const runCompletion = vi.fn(async () => "Completion after session throw.");
    const d = deps({ agenticEnabled: true, sessionConfig: SESSION_CONFIG, runSession, runCompletion });

    const result = await narrateRouterProposal(PROPOSAL, TASK, d);

    expect(result.hermesMode).toBe("live");
    expect(result.text).toBe("Completion after session throw.");
  });

  it("falls back to the canned TEMPLATE and stays templated when both transports fail", async () => {
    const runSession = vi.fn(async () => null);
    const runCompletion = vi.fn(async () => null);
    const d = deps({ agenticEnabled: true, sessionConfig: SESSION_CONFIG, runSession, runCompletion });

    const result = await narrateRouterProposal(PROPOSAL, TASK, d);

    expect(result.hermesMode).toBe("templated");
    expect(result.text).toBe(fallback(PROPOSAL, TASK));
    expect(d.calls[0]).toMatchObject({ hermesMode: "templated" });
  });

  it("uses the template (templated) when there is no completion transport either (no OLLAMA key)", async () => {
    const d = deps({ agenticEnabled: false, sessionConfig: null });
    const result = await narrateRouterProposal(PROPOSAL, TASK, d);
    expect(result.hermesMode).toBe("templated");
    expect(result.text).toBe(fallback(PROPOSAL, TASK));
  });
});

describe("narrateRouterProposal — honesty tagging never over-claims", () => {
  it("an empty/whitespace session reply is treated as no reply (not tagged live off blank text)", async () => {
    const runSession = vi.fn(async () => turn("   "));
    const runCompletion = vi.fn(async () => "Completion fills in.");
    const d = deps({ agenticEnabled: true, sessionConfig: SESSION_CONFIG, runSession, runCompletion });

    const result = await narrateRouterProposal(PROPOSAL, TASK, d);
    // blank agentic text must not be recorded as live; the completion is used
    expect(result.hermesMode).toBe("live");
    expect(result.text).toBe("Completion fills in.");
  });

  it("records under the proposal's correlation id (falling back to the router correlation id)", async () => {
    const d = deps();
    await narrateRouterProposal(PROPOSAL, { id: "task-9" }, d);
    expect(d.calls[0]!.relatedCorrelationId).toBe(routerNarrationCorrelationId(PROPOSAL, { id: "task-9" }));
    expect(d.calls[0]!.relatedCorrelationId).toBe("hermes-router:depre-dev/averray-reference-agent|monitor-board|monitor-board");
  });
});

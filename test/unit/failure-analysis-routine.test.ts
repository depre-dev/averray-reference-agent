import { describe, expect, it, vi } from "vitest";

import type { HermesSessionConfig, HermesSessionTurn } from "../../services/slack-operator/src/hermes-session-client.js";
import type { FailureAnalysisCard } from "../../services/slack-operator/src/monitor-failure-analysis.js";
import { hashFailureContext } from "../../services/slack-operator/src/monitor-failure-analysis.js";
import {
  runFailureAnalysisOnce,
  type FailureAnalysisRoutineConfig,
  type FailureAnalysisRoutineDeps,
} from "../../services/slack-operator/src/failure-analysis-routine.js";

const SESSION_CONFIG: HermesSessionConfig = { baseUrl: "http://gw:8642", apiToken: "tok" };

const CARD: FailureAnalysisCard = {
  id: "deploy-abc",
  title: "Deploy monitor stack",
  repo: "depre-dev/averray-reference-agent",
  verdict: "deploy failed",
  failedCheckNames: ["unit tests"],
  failureKind: "deploy verification",
};

function turn(text: string, model?: string): HermesSessionTurn {
  return { sessionId: "s1", text, ...(model ? { model } : {}) };
}

const CONFIG: FailureAnalysisRoutineConfig = { enabled: true, intervalMs: 300_000, maxPerTick: 3 };

/** A store double that records writes and can seed a fresh entry. */
function store(seed: Record<string, { text: string; failureHash: string }> = {}) {
  const written: Array<{ cardId: string; value: { text: string; model?: string; failureHash: string } }> = [];
  const state = new Map(Object.entries(seed));
  return {
    written,
    readFresh: (cardId: string, failureHash: string) => {
      const hit = state.get(cardId);
      return hit && hit.failureHash === failureHash ? { text: hit.text } : undefined;
    },
    write: (cardId: string, value: { text: string; model?: string; failureHash: string }) => {
      written.push({ cardId, value });
      state.set(cardId, { text: value.text, failureHash: value.failureHash });
    },
  };
}

function deps(overrides: Partial<FailureAnalysisRoutineDeps> = {}): FailureAnalysisRoutineDeps {
  const s = store();
  return {
    listFailureCards: () => [CARD],
    readFresh: s.readFresh,
    write: s.write,
    analysisDeps: {
      enabled: true,
      sessionConfig: SESSION_CONFIG,
      runSession: vi.fn(async () => turn("Grounded read: unit tests failed; roll back and re-run.")),
    },
    isSuspended: () => false,
    isHalt: () => false,
    ...overrides,
  };
}

describe("runFailureAnalysisOnce — flag + guardrails", () => {
  it("is a no-op when the flag is off (byte-for-byte today: no session, no write)", async () => {
    const runSession = vi.fn(async () => turn("x"));
    const write = vi.fn();
    const result = await runFailureAnalysisOnce(
      { ...CONFIG, enabled: false },
      deps({ write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(result.status).toBe("disabled");
    expect(runSession).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("parks under a HALT (never analyzes while halted)", async () => {
    const runSession = vi.fn(async () => turn("x"));
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ isHalt: () => true, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(result.status).toBe("paused");
    expect(result.reason).toBe("halt_present");
    expect(runSession).not.toHaveBeenCalled();
  });

  it("parks when autopilot is suspended", async () => {
    const result = await runFailureAnalysisOnce(CONFIG, deps({ isSuspended: () => true }));
    expect(result.status).toBe("paused");
    expect(result.reason).toBe("autopilot_suspended");
  });
});

describe("runFailureAnalysisOnce — analyze + cache by hash", () => {
  it("analyzes a failed card and caches it keyed by card id + failure hash", async () => {
    const s = store();
    const runSession = vi.fn(async () => turn("unit tests failed; roll back and re-run.", "hermes-4"));
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );

    expect(result.status).toBe("analyzed");
    expect(result.analyzed).toEqual([{ cardId: "deploy-abc" }]);
    expect(s.written).toHaveLength(1);
    expect(s.written[0]!.cardId).toBe("deploy-abc");
    expect(s.written[0]!.value.failureHash).toBe(hashFailureContext(CARD));
    expect(s.written[0]!.value.model).toBe("hermes-4");
    // the grounded prompt was threaded with the card's real failure fields
    expect((runSession.mock.calls[0]![1] as string)).toContain("unit tests");
  });

  it("skips a card that already has a FRESH cached analysis (re-runs only when the failure changes)", async () => {
    const runSession = vi.fn(async () => turn("new analysis"));
    const s = store({ "deploy-abc": { text: "cached", failureHash: hashFailureContext(CARD) } });
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(runSession).not.toHaveBeenCalled();
    expect(s.written).toHaveLength(0);
    expect(result.status).toBe("idle");
    expect(result.reason).toBe("all_fresh");
  });

  it("re-runs when the cached analysis is STALE for the current failure (hash changed)", async () => {
    const runSession = vi.fn(async () => turn("fresh analysis for the changed failure"));
    // seeded under a DIFFERENT hash -> stale
    const s = store({ "deploy-abc": { text: "old", failureHash: "deadbeef" } });
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(s.written).toHaveLength(1);
    expect(result.status).toBe("analyzed");
  });

  it("skips a card with no diagnosable detail (won't ask Hermes to guess a bare 'failed')", async () => {
    const runSession = vi.fn(async () => turn("x"));
    const bare: FailureAnalysisCard = { id: "bare", title: "Failed", verdict: "failed", state: "failed-fetch" };
    const s = store();
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ listFailureCards: () => [bare], readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(runSession).not.toHaveBeenCalled();
    expect(s.written).toHaveLength(0);
    expect(result.status).toBe("idle");
  });

  it("caps analyses per tick at maxPerTick", async () => {
    const cards: FailureAnalysisCard[] = [
      { ...CARD, id: "c1" },
      { ...CARD, id: "c2" },
      { ...CARD, id: "c3" },
    ];
    const runSession = vi.fn(async () => turn("grounded read"));
    const s = store();
    const result = await runFailureAnalysisOnce(
      { ...CONFIG, maxPerTick: 2 },
      deps({ listFailureCards: () => cards, readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(s.written).toHaveLength(2);
    expect(result.analyzed).toHaveLength(2);
  });
});

describe("runFailureAnalysisOnce — degraded-safe (no fabricated cache)", () => {
  it("writes NOTHING when the session is unavailable (gateway down) — drawer keeps its pointer", async () => {
    const s = store();
    // sessionConfig null -> analyzeCardFailure returns { hermesMode: "none" }
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: null, runSession: vi.fn() } }),
    );
    expect(s.written).toHaveLength(0);
    expect(result.status).toBe("idle");
    // there WAS a failure card needing analysis, but the gateway was down —
    // report "degraded", never "all_fresh" / "no_failure_cards".
    expect(result.reason).toBe("degraded");
  });

  it("writes NOTHING when the session returns null (never caches a fabricated cause)", async () => {
    const s = store();
    const runSession = vi.fn(async () => null);
    const result = await runFailureAnalysisOnce(
      CONFIG,
      deps({ readFresh: s.readFresh, write: s.write, analysisDeps: { enabled: true, sessionConfig: SESSION_CONFIG, runSession } }),
    );
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(s.written).toHaveLength(0);
    expect(result.status).toBe("idle");
    expect(result.reason).toBe("degraded");
  });

  it("returns idle with no failure cards on the board", async () => {
    const result = await runFailureAnalysisOnce(CONFIG, deps({ listFailureCards: () => [] }));
    expect(result.status).toBe("idle");
    expect(result.reason).toBe("no_failure_cards");
  });
});

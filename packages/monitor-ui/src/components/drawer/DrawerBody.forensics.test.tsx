// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DrawerBody } from "./DrawerBody.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

const base = {
  lane: "hermes-checking",
  agentType: "hermes",
  repo: "averray-reference-agent",
  freshness: 1,
  risk: [],
  waitingOn: { actor: "agent", tone: "neutral" },
};

function missionCard(over: Record<string, unknown>): BoardCard {
  return {
    id: "m1",
    type: "mission",
    title: "Citation repair dry run",
    summary: "",
    state: "fresh",
    ...base,
    ...over,
  } as unknown as BoardCard;
}

const report = (over: Record<string, unknown> = {}) => ({
  verdict: "OK",
  verdictTone: "ok",
  confidence: 0.82,
  target: "en.wikipedia.org",
  seed: "fresh · no memory",
  goal: "repair dead links",
  conclusion: "",
  narrative: "",
  path: [],
  blockers: [],
  evidence: [],
  scores: [],
  recommendations: [],
  mutationBoundary: "Dry run — no claim or submit attempted.",
  ...over,
});

describe("PR-D2b — Mission forensics (expected vs observed)", () => {
  test("renders the eo table + env/identity badges from real fields", () => {
    const { container } = render(<DrawerBody card={missionCard({ missionStatus: "completed", mission: report() })} variant="mission" />);
    const eo = container.querySelector(".h4-eo");
    expect(eo).toBeTruthy();
    expect(eo?.textContent).toMatch(/Confidence/);
    expect(eo?.textContent).toMatch(/met/); // 0.82 ≥ 70% → criterion met
    expect(eo?.textContent).toMatch(/Mutation boundary/);
    expect(eo?.textContent).toMatch(/enforced/);
    const env = container.querySelector(".h4-env");
    expect(env?.textContent).toMatch(/agent · hermes/);
    expect(env?.textContent).toMatch(/en\.wikipedia\.org/);
  });

  test("a failed mission gets an honest awaiting-data failure-frame slot", () => {
    const { container } = render(
      <DrawerBody card={missionCard({ missionStatus: "failed", mission: report({ verdict: "FAILED", verdictTone: "fail", confidence: 0.4 }) })} variant="mission" />
    );
    const awaiting = container.querySelector(".h4-awaiting");
    expect(awaiting?.textContent).toMatch(/Failure frame/);
    expect(awaiting?.textContent).toMatch(/awaiting data/i);
    // criterion below the bar
    expect(container.querySelector(".h4-eo")?.textContent).toMatch(/below/);
  });
});

describe("PR-D2b — live-follow frame", () => {
  test("a running mission with no streamed screenshot shows an honest 'Latest frame' awaiting-data slot", () => {
    const { container } = render(<DrawerBody card={missionCard({ missionStatus: "running", missionProgress: { message: "step 1" } })} variant="mission" />);
    const awaiting = container.querySelector(".h4-awaiting");
    expect(awaiting?.textContent).toMatch(/Latest frame/);
    expect(awaiting?.textContent).toMatch(/awaiting data/i);
  });

  test("a running mission with a real screenshot shows it (no awaiting slot)", () => {
    const { container } = render(
      <DrawerBody card={missionCard({ missionStatus: "running", missionProgress: { message: "step 2", screenshot: "https://x.test/s.png" } })} variant="mission" />
    );
    expect(container.querySelector("img[alt='Latest mission screenshot']")).toBeTruthy();
    expect(container.querySelector(".h4-awaiting")).toBeNull();
  });
});

describe("PR-D2b — Task convert-to-bug preview", () => {
  function taskCard(over: Record<string, unknown>): BoardCard {
    return { id: "t1", type: "task", title: "Fix the adapter", summary: "", state: "fresh", prompt: "do the thing", ...base, ...over } as unknown as BoardCard;
  }
  test("drafts a bug from the task's real risk area + failure reason", () => {
    const { container } = render(
      <DrawerBody card={taskCard({ risk: ["workflow"], failureReason: "runner exited non-zero" })} variant="task" />
    );
    const bug = container.querySelector(".h4-bug");
    expect(bug).toBeTruthy();
    expect(bug?.textContent).toMatch(/workflow/);
    expect(bug?.textContent).toMatch(/runner exited non-zero/);
  });
  test("degrades to an honest awaiting-data slot with no area or failure", () => {
    const { container } = render(<DrawerBody card={taskCard({ risk: [] })} variant="task" />);
    expect(container.querySelector(".h4-bug")).toBeNull();
    expect(container.querySelector(".h4-awaiting")?.textContent).toMatch(/Bug preview/);
  });
});

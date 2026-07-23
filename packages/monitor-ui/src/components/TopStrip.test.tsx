// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TopStrip } from "./TopStrip.js";
import type { KPICounts } from "../lib/monitor/board-state.js";

afterEach(cleanup);

const calmCounts: KPICounts = {
  action: 0,
  codex: 0,
  review: 0,
  checking: 0,
  queue: 0,
  deploying: 0,
  blocked: 0,
  done: 11,
  total: 0,
};

const busyCounts: KPICounts = {
  action: 2,
  codex: 2,
  review: 1,
  checking: 3,
  queue: 1,
  deploying: 1,
  blocked: 0,
  done: 4,
  total: 8,
};

describe("TopStrip", () => {
  test("renders the brand mark and banner role", () => {
    const { getByText, getByRole } = render(<TopStrip counts={calmCounts} />);
    expect(getByText("Hermes")).toBeTruthy();
    expect(getByText("Handoff monitor · Averray")).toBeTruthy();
    expect(getByRole("banner")).toBeTruthy();
  });

  test("renders KPI labels with their counts", () => {
    const { getByText } = render(<TopStrip counts={busyCounts} />);
    // Each KPI label is present; the count lives in the sibling `.n` span.
    expect(getByText("Action needed")).toBeTruthy();
    expect(getByText("Work queue")).toBeTruthy();
    expect(getByText("Operator review")).toBeTruthy();
    expect(getByText("Hermes checking")).toBeTruthy();
    expect(getByText("Release queue")).toBeTruthy();
    expect(getByText("Deploying")).toBeTruthy();
  });

  test("zero-count KPIs wear the --zero modifier, non-zero do not", () => {
    const { container } = render(<TopStrip counts={busyCounts} />);
    const kpis = container.querySelectorAll(".hm-kpi");
    // First KPI (action=2) should be the --action variant, not --zero.
    const action = kpis[0] as HTMLElement;
    expect(action.className).toContain("hm-kpi--action");
    expect(action.className).not.toContain("hm-kpi--zero");
  });

  test("zero counts render the --zero modifier", () => {
    const { container } = render(<TopStrip counts={calmCounts} />);
    const action = container.querySelector(".hm-kpi") as HTMLElement;
    expect(action.className).toContain("hm-kpi--zero");
  });

  test("shows the live timestamp when provided, dash otherwise", () => {
    const withTime = render(<TopStrip counts={calmCounts} liveAt="14:32:08" />);
    expect(withTime.getByText(/Live · 14:32:08/)).toBeTruthy();

    const noTime = render(<TopStrip counts={calmCounts} />);
    expect(noTime.getByText(/Live · —/)).toBeTruthy();
  });

  test("refresh button is disabled without a handler", () => {
    const { getByRole } = render(<TopStrip counts={calmCounts} />);
    const disabledBtn = getByRole("button", { name: "Refresh board" }) as HTMLButtonElement;
    expect(disabledBtn.disabled).toBe(true);
  });

  test("refresh button is enabled and fires when given a handler", () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(<TopStrip counts={calmCounts} onRefresh={onRefresh} />);
    const btn = getByRole("button", { name: "Refresh board" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("renders the deploy-health pill", () => {
    const { getByText } = render(<TopStrip counts={calmCounts} deployHealth="DEGRADED" />);
    expect(getByText(/Deploy DEGRADED/)).toBeTruthy();
  });

  test("renders one quiet automation-health gauge when provided", () => {
    const { getByLabelText, getByText } = render(
      <TopStrip
        counts={calmCounts}
        automationHealth={{ selfHealingOpen: 2, dispatchUsedToday: 4, dispatchPerDayCap: 5 }}
      />,
    );
    expect(getByText("Self-heal 2 open · dispatch 4/5")).toBeTruthy();
    expect(getByLabelText("Automation health: Self-heal 2 open · dispatch 4/5")).toBeTruthy();
  });

  test("folds Slack-only capacity signals into the same gauge line", () => {
    const { getByLabelText, getByText } = render(
      <TopStrip
        counts={calmCounts}
        automationHealth={{
          selfHealingOpen: 2,
          dispatchUsedToday: 4,
          dispatchPerDayCap: 5,
          quietSignalCount: 1,
          selfHealingCapacitySignals: 1,
          taskHealthCapacitySignals: 0,
        }}
      />,
    );
    expect(getByText("Self-heal 2 open · dispatch 4/5 · quiet 1")).toBeTruthy();
    expect(getByLabelText("Automation health: Self-heal 2 open · dispatch 4/5 · quiet 1")).toBeTruthy();
  });

  test("automation gauge opens a real self-management diagnostics panel", () => {
    const { getByLabelText, getByText } = render(
      <TopStrip
        counts={calmCounts}
        automationHealth={{
          sourceStatus: "ok",
          selfHealingOpen: 1,
          dispatchUsedToday: 3,
          dispatchPerDayCap: 10,
          quietSignalCount: 0,
          taskHealth: {
            status: "stuck",
            runningTasks: 2,
            stuckTasks: 1,
            retryWaitingTasks: 1,
            escalatedTasks: 1,
            runner: {
              status: "stale",
              reason: "runner_heartbeat_stale",
              activeTaskId: "task-1",
              ageMs: 120_000,
            },
          },
          routing: {
            status: "baseline_available",
            decisionsToday: 2,
            surfaces: 1,
            baselineSurfaces: 1,
            insufficientSurfaces: 0,
            top: {
              surface: "ops hygiene",
              agent: "codex",
              score: 78,
              samples: 3,
            },
          },
        }}
      />,
    );

    fireEvent.click(getByLabelText("Automation health: Self-heal 1 open · dispatch 3/10 · stuck 1"));
    expect(getByText("Task health")).toBeTruthy();
    expect(getByText("stuck · 2 running · 1 stuck · 1 retry waiting · 1 escalated")).toBeTruthy();
    expect(getByText("Routing memory")).toBeTruthy();
    expect(getByText(/baseline available · 1 baseline · 0 sparse · 2 decisions today/)).toBeTruthy();
    expect(getByText(/Retries stay bounded and respect dispatch policy/)).toBeTruthy();
  });

  test("automation gauge shows unknowns when task-queue counts are degraded", () => {
    const { getByLabelText, getByText } = render(
      <TopStrip
        counts={calmCounts}
        automationHealth={{
          sourceStatus: "degraded",
          selfHealingOpen: null,
          dispatchUsedToday: null,
          dispatchPerDayCap: 10,
          quietSignalCount: null,
          taskHealth: {
            status: "unknown",
            runningTasks: 0,
            stuckTasks: 0,
            retryWaitingTasks: 0,
            escalatedTasks: 0,
            runner: { status: "unknown", reason: "task_queue_unavailable" },
          },
          routing: {
            status: "unknown",
            decisionsToday: null,
            surfaces: null,
            baselineSurfaces: null,
            insufficientSurfaces: null,
          },
        }}
      />,
    );

    expect(getByText("Self-heal ? open · dispatch ?/10 · quiet ? · source ?")).toBeTruthy();
    fireEvent.click(getByLabelText("Automation health: Self-heal ? open · dispatch ?/10 · quiet ? · source ?"));
    expect(getByText("Task health")).toBeTruthy();
    expect(getByText("unknown · task_queue_unavailable")).toBeTruthy();
    expect(getByText("Dispatch ? of 10")).toBeTruthy();
  });
});

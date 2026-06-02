// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { MonitorPage } from "./MonitorPage.js";
import { FIXTURE_CARDS } from "./lib/monitor/fixtures.js";
import type { MonitorBoard } from "./lib/monitor/board-cache.js";
import type { BoardCard } from "./lib/monitor/card-types.js";
import type { StorageLike } from "./lib/monitor/snapshot-store.js";

afterEach(cleanup);

// Minimal EventSource stand-in so the container's SSE effect is inert
// in tests (the fetched board is enough to drive a render).
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {}
}
const ES = FakeEventSource as unknown as typeof EventSource;

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function taskCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "codex-task-1",
    lane: "codex-needed",
    type: "task",
    agentType: "codex",
    title: "Investigate board card",
    summary: "A proposed task is waiting for operator action.",
    repo: "depre-dev/averray-reference-agent",
    freshness: 1,
    state: "fresh",
    risk: ["workflow"],
    waitingOn: { actor: "operator", tone: "warn" },
    taskStatus: "proposed",
    ...overrides,
  } as BoardCard;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  window.history.replaceState({}, "", "/");
});

describe("MonitorPage — container", () => {
  test("wires fetched live board data into the BoardView", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    const { container } = render(<MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} collaboration={{ enabled: false }} alerts={{ enabled: false }} />, {
      wrapper,
    });

    // Once the fetch resolves, the rich-mix board renders.
    await waitFor(() =>
      expect(within(container).getByText("Allow operator override of agent claim-stake floor")).toBeTruthy(),
    );
    expect(within(container).getByRole("banner")).toBeTruthy();
    expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });

  test("clicking a card opens the drawer and sets ?card=; esc closes it and clears the param", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    const { container } = render(<MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} collaboration={{ enabled: false }} alerts={{ enabled: false }} />, {
      wrapper,
    });

    const view = within(container);
    await waitFor(() => expect(view.getByRole("button", { name: /Allow operator override/ })).toBeTruthy());

    // Click the action card → drawer opens, URL carries the focused card.
    fireEvent.click(view.getByRole("button", { name: /Allow operator override/ }));
    await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
    expect(new URLSearchParams(window.location.search).get("card")).toBe("agent #548");

    // Esc closes the drawer and clears the param.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(new URLSearchParams(window.location.search).get("card")).toBeNull();
  });

  test("renders the board chrome without crashing when the fetch fails", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => {
      throw new Error("no backend");
    });
    const { container } = render(<MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} collaboration={{ enabled: false }} alerts={{ enabled: false }} />, {
      wrapper,
    });

    // Chrome is present even with no board data — no blank screen, no throw.
    await waitFor(() => expect(within(container).getByRole("banner")).toBeTruthy());
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
    expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });

  test("the composer's /mission command reaches the spawn handler", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    const onSpawnMission = vi.fn();
    const { container } = render(
      <MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} onSpawnMission={onSpawnMission} collaboration={{ enabled: false }} alerts={{ enabled: false }} />,
      { wrapper },
    );
    await waitFor(() => expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy());

    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/mission https://staging.averray.com/onboarding" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSpawnMission).toHaveBeenCalledWith("https://staging.averray.com/onboarding");
  });

  test("the default spawn POSTs targetUrl to /monitor/testbed-missions", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    // The board fetch uses the injected fetcher; defaultSpawnMission uses
    // the global fetch — so spying on it isolates the spawn call.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const { container } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() =>
        expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy(),
      );

      const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "/mission https://x.test/y" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("/monitor/testbed-missions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ targetUrl: "https://x.test/y" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the board launcher POSTs an explicit mission request without mutation flags", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: [], at: "2026-05-28T10:30:00Z" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const { getByRole, getByLabelText } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: "Start a mission" })).toBeTruthy());

      fireEvent.click(getByRole("button", { name: "Start a mission" }));
      fireEvent.change(getByLabelText("Target"), { target: { value: "https://app.averray.com/agent" } });
      fireEvent.click(getByLabelText(/Gold Path/));
      fireEvent.click(getByLabelText("Memory"));
      fireEvent.change(getByLabelText("Goal"), { target: { value: "prove the signed-in receipt loop" } });
      fireEvent.click(getByLabelText(/Request approval/));
      fireEvent.click(getByRole("button", { name: "Launch mission" }));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("/monitor/testbed-missions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        targetUrl: "https://app.averray.com/agent",
        mode: "gold_path",
        freshMemory: false,
        initialStatus: "requested",
        goal: "prove the signed-in receipt loop",
      });
      expect(JSON.parse(String(init.body))).not.toHaveProperty("allowTestMutations");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the board launcher can save the launched config as a suite", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: [], at: "2026-05-28T10:30:00Z" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const { getByRole, getByLabelText } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: "Start a mission" })).toBeTruthy());

      fireEvent.click(getByRole("button", { name: "Start a mission" }));
      fireEvent.change(getByLabelText("Target"), { target: { value: "https://app.averray.com/overview" } });
      fireEvent.click(getByLabelText(/Save this config as a suite/));
      fireEvent.change(getByLabelText("Suite name"), { target: { value: "Daily app sweep" } });
      fireEvent.click(getByRole("button", { name: "Launch mission" }));

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [missionUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const [suiteUrl, suiteInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(missionUrl).toBe("/monitor/testbed-missions");
      expect(suiteUrl).toBe("/monitor/suites");
      expect(JSON.parse(String(suiteInit.body))).toEqual({
        name: "Daily app sweep",
        target: "https://app.averray.com/overview",
        mode: "surface_sweep",
        author: "operator",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the saved suite Run button POSTs to /monitor/suites/:id/run", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({
      cards: [],
      at: "2026-05-28T10:30:00Z",
      testbedSuites: [{
        schemaVersion: 1,
        kind: "testbed_suite",
        id: "testbed-suite-daily-app-sweep-1",
        name: "Daily app sweep",
        target: "https://app.averray.com",
        mode: "surface_sweep",
        author: "operator",
        createdAt: "2026-05-28T10:00:00.000Z",
        updatedAt: "2026-05-28T10:00:00.000Z",
        history: [],
      }],
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const { getByRole } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: "Run" })).toBeTruthy());

      fireEvent.click(getByRole("button", { name: "Run" }));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("/monitor/suites/testbed-suite-daily-app-sweep-1/run");
      expect(init.method).toBe("POST");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("requested suite approval and dismiss POST to the suite endpoints", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({
      cards: [],
      at: "2026-05-28T10:30:00Z",
      testbedSuites: [{
        schemaVersion: 1,
        kind: "testbed_suite",
        id: "testbed-suite-settings-coverage-1",
        status: "requested",
        name: "Settings coverage gap",
        target: "https://app.averray.com/settings",
        mode: "surface_sweep",
        author: "test-writer",
        requesterAgent: "test-writer",
        requestReason: "Changed surface has no saved regression suite.",
        requestedAt: "2026-05-28T10:00:00.000Z",
        createdAt: "2026-05-28T10:00:00.000Z",
        updatedAt: "2026-05-28T10:00:00.000Z",
        history: [],
      }],
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const { getByRole } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: "Approve" })).toBeTruthy());

      fireEvent.click(getByRole("button", { name: "Approve" }));
      fireEvent.click(getByRole("button", { name: "Dismiss" }));

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [approveUrl, approveInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const [dismissUrl, dismissInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(approveUrl).toBe("/monitor/suites/testbed-suite-settings-coverage-1/approve");
      expect(approveInit.method).toBe("POST");
      expect(dismissUrl).toBe("/monitor/suites/testbed-suite-settings-coverage-1/dismiss");
      expect(dismissInit.method).toBe("POST");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the default mission approval POSTs to /monitor/testbed-missions/:id/approve", async () => {
    const requestedMission = {
      id: "testbed-mission-requested-1",
      lane: "operator-review",
      type: "mission",
      agentType: "hermes",
      title: "Tester run requested",
      summary: "Tester run requested by codex; it has not started and remains board-gated until the operator approves it.",
      repo: "testbed/mission",
      freshness: 1,
      state: "fresh",
      risk: ["testbed"],
      waitingOn: { actor: "operator", tone: "neutral" },
      missionStatus: "requested",
    } as unknown as MonitorBoard["cards"][number];
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({
      cards: [requestedMission],
      at: "2026-05-28T10:30:00Z",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const { getByRole } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy());
      fireEvent.click(getByRole("button", { name: /Approve & dispatch/ }));
      fireEvent.click(getByRole("button", { name: /^Confirm$/ }));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("/monitor/testbed-missions/testbed-mission-requested-1/approve");
      expect(init.method).toBe("POST");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("requested mission dismiss POSTs to /monitor/testbed-missions/:id/dismiss", async () => {
    const requestedMission = {
      id: "testbed-mission-requested-1",
      lane: "operator-review",
      type: "mission",
      agentType: "hermes",
      title: "Tester run requested",
      summary: "Tester run requested by codex; it has not started and remains board-gated until the operator approves it.",
      repo: "testbed/mission",
      freshness: 1,
      state: "fresh",
      risk: ["testbed"],
      waitingOn: { actor: "operator", tone: "neutral" },
      missionStatus: "requested",
    } as unknown as MonitorBoard["cards"][number];
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({
      cards: [requestedMission],
      at: "2026-05-28T10:30:00Z",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const { getByRole, getByText } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: "Dismiss" })).toBeTruthy());
      fireEvent.click(getByRole("button", { name: "Dismiss" }));
      expect(getByText(/Dismiss this requested tester mission/)).toBeTruthy();
      fireEvent.click(getByRole("button", { name: /^Confirm$/ }));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("/monitor/testbed-missions/testbed-mission-requested-1/dismiss");
      expect(init.method).toBe("POST");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("failed mission triage posts accept/open-issue actions to real mission endpoints", async () => {
    const failedMission = {
      id: "surface-sweep-t1-testbed-mission-failed-1",
      correlationId: "testbed-mission-failed-1",
      lane: "needs-attention",
      type: "mission",
      agentType: "hermes",
      title: "Surface sweep (T1)",
      summary: "Browser-agent report returned fail.",
      repo: "testbed/mission",
      freshness: 1,
      state: "fresh",
      risk: ["testbed"],
      waitingOn: { actor: "operator", tone: "warn" },
      missionStatus: "failed",
      isAction: true,
      mission: {
        verdict: "FAILED",
        verdictTone: "fail",
        confidence: 0.4,
        target: "https://staging.example.test",
        seed: "fresh",
        path: [],
        blockers: [],
        evidence: [],
        mutationBoundary: "No mutation crossed.",
        recommendations: [],
      },
    } as unknown as MonitorBoard["cards"][number];
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({
      cards: [failedMission],
      at: "2026-05-28T10:30:00Z",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const { getByRole, getByText } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: "Accept failure" })).toBeTruthy());

      fireEvent.click(getByRole("button", { name: "Accept failure" }));
      expect(getByText(/Accept this failed mission/)).toBeTruthy();
      fireEvent.click(getByRole("button", { name: /^Confirm$/ }));

      fireEvent.click(getByRole("button", { name: "Open issue" }));
      expect(getByText(/File a GitHub issue/)).toBeTruthy();
      fireEvent.click(getByRole("button", { name: /^Confirm$/ }));

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect((fetchSpy.mock.calls[0] as [string, RequestInit])[0]).toBe("/monitor/testbed-missions/testbed-mission-failed-1/accept-failure");
      expect((fetchSpy.mock.calls[1] as [string, RequestInit])[0]).toBe("/monitor/testbed-missions/testbed-mission-failed-1/open-issue");
      expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].method).toBe("POST");
      expect((fetchSpy.mock.calls[1] as [string, RequestInit])[1].method).toBe("POST");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("operator task cards do not expose secondary dismiss/snooze buttons", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({
      cards: [taskCard()],
      at: "2026-05-28T10:30:00Z",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const { getByRole, queryByRole } = render(
        <MonitorPage
          options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
          backlogSuggestions={{ enabled: false }}
          collaboration={{ enabled: false }}
          alerts={{ enabled: false }}
          autonomy={{ fetchMode: async () => null }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy());
      expect(queryByRole("button", { name: "Dismiss" })).toBeNull();
      expect(queryByRole("button", { name: "Snooze" })).toBeNull();

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the composer's /mute command mutes alerts end-to-end", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    const storage = memStorage();
    const { container } = render(
      <MonitorPage
        options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
        collaboration={{ enabled: false }}
        alerts={{ enabled: false, storage, now: () => 1_000 }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy());

    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/mute 1h" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The mute flows command → CoPilotRail → useActionAlerts → muted chip.
    await waitFor(() => expect(within(container).getByText("alerts muted")).toBeTruthy());
    expect(storage.getItem("monitor.mute.until")).toBeTruthy();
  });

  test("the board toggle posts autopilot, and the NL command reverts to supervised", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    const postMode = vi.fn(async (body: { mode: string }) => (body.mode === "autopilot" ? "autopilot" as const : "supervised" as const));
    const { container } = render(
      <MonitorPage
        options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }}
        collaboration={{ enabled: false }}
        alerts={{ enabled: false }}
        autonomy={{ fetchMode: async () => "supervised", postMode }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy());

    // Toggle chip starts supervised; clicking engages autopilot (open-ended → server cap).
    const toggle = within(container).getByText("○ supervised").closest("button") as HTMLButtonElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(postMode).toHaveBeenCalledWith({ mode: "autopilot" }));
    await waitFor(() => expect(within(container).getByText("● autopilot")).toBeTruthy());

    // The NL command "I'm back" reverts to supervised.
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "I'm back" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(postMode).toHaveBeenCalledWith({ mode: "supervised" }));
    await waitFor(() => expect(within(container).getByText("○ supervised")).toBeTruthy());
  });
});

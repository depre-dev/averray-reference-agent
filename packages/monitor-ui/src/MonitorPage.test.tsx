// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { MonitorPage } from "./MonitorPage.js";
import { FIXTURE_CARDS } from "./lib/monitor/fixtures.js";
import type { MonitorBoard } from "./lib/monitor/board-cache.js";
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

beforeEach(() => {
  FakeEventSource.instances = [];
  window.history.replaceState({}, "", "/");
});

describe("MonitorPage — container", () => {
  test("wires fetched live board data into the BoardView", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" }));
    const { container } = render(<MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} />, {
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
    const { container } = render(<MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} />, {
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
    const { container } = render(<MonitorPage options={{ fetcher, EventSourceCtor: ES, storage: memStorage() }} />, {
      wrapper,
    });

    // Chrome is present even with no board data — no blank screen, no throw.
    await waitFor(() => expect(within(container).getByRole("banner")).toBeTruthy());
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
    expect(within(container).getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });
});

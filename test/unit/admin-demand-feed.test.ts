import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AdminDemandSessionCache,
  readAdminDemandFeed,
} from "../../services/slack-operator/src/admin-demand-feed.js";

const TIMELINE = {
  schemaVersion: "averray.admin.arrivals.timeline.v1",
  generatedAt: "2026-08-22T10:00:00.000Z",
  collectionSince: "2026-08-21T08:00:00.000Z",
  buckets: [],
};

const JOURNEYS = {
  schemaVersion: "averray.admin.worker-journeys.v1",
  generatedAt: "2026-08-22T10:00:00.000Z",
  collectionSince: "2026-08-21T09:00:00.000Z",
  journeys: [],
};

describe("admin arrivals and journeys feed", () => {
  it("reads both Part A endpoints in parallel with one server-side SIWE bearer", async () => {
    const pending: Array<() => void> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((resolve) => pending.push(resolve));
      const body = String(url).includes("arrivals/timeline") ? TIMELINE : JOURNEYS;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-session");
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const reading = readAdminDemandFeed({
      baseUrl: "https://api.example.test/",
      window: "48h",
      limit: 50,
      getSession: async () => ({ token: "admin-session", expiresAt: "2026-08-22T12:00:00.000Z" }),
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date("2026-08-22T10:01:00.000Z"),
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    pending.splice(0).forEach((resolve) => resolve());
    const feed = await reading;

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/admin/arrivals/timeline?window=48h",
      "https://api.example.test/admin/worker-journeys?limit=50",
    ]);
    expect(feed.collectionSince).toBe("2026-08-21T09:00:00.000Z");
    expect(feed.timeline).toEqual(TIMELINE);
    expect(feed.journeys).toEqual(JOURNEYS);
  });

  it("keeps one failed admin read explicit without hiding the other feed", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes("arrivals/timeline")
      ? new Response("forbidden", { status: 403 })
      : new Response(JSON.stringify(JOURNEYS), { status: 200 }));
    const feed = await readAdminDemandFeed({
      baseUrl: "https://api.example.test",
      window: "30d",
      limit: 25,
      getSession: async () => ({ token: "not-admin" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(feed.timeline).toEqual({ unavailable: "arrivals timeline returned HTTP 403" });
    expect(feed.journeys).toEqual(JOURNEYS);
  });

  it("single-flights login and renews before the cached bearer expires", async () => {
    let nowMs = Date.parse("2026-08-22T10:00:00.000Z");
    const login = vi.fn(async () => ({ token: `session-${login.mock.calls.length}`, expiresAt: "2026-08-22T10:10:00.000Z" }));
    const cache = new AdminDemandSessionCache(login, () => nowMs);

    const [first, second] = await Promise.all([cache.get(), cache.get()]);
    expect(first.token).toBe(second.token);
    expect(login).toHaveBeenCalledTimes(1);

    nowMs = Date.parse("2026-08-22T10:09:30.000Z");
    await cache.get();
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("keeps the browser route behind the existing monitor authorization guard", () => {
    const source = fs.readFileSync(path.resolve("services/slack-operator/src/index.ts"), "utf8");
    const routeStart = source.indexOf('url.pathname === "/monitor/admin-demand"');
    const routeEnd = source.indexOf("return;", source.indexOf("readAdminDemandFeed", routeStart));
    const route = source.slice(routeStart, routeEnd);
    expect(routeStart).toBeGreaterThan(0);
    expect(route, "admin payload must never bypass the operator board auth boundary").toContain("isMonitorAuthorized");
    expect(route).toContain("readAdminDemandFeed");
    expect(route, "wallet journeys must not land in a shared browser or proxy cache").toContain('"cache-control", "private, no-store"');
  });
});

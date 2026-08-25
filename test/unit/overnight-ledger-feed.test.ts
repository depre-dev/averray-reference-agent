import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createAdminReadSessionProvider,
  readAdminDemandFeed,
} from "../../services/slack-operator/src/admin-demand-feed.js";
import { readOvernightLedgerFeed } from "../../services/slack-operator/src/overnight-ledger-feed.js";

const LEDGER = {
  window: "24h",
  generatedAt: "2026-08-24T05:00:00.000Z",
  reconciliation: {},
  workers: { items: [], totals: {} },
  rewardBankSplit: {},
  retention: {},
  digest: {},
  events: { items: [], totalCount: 0, returnedCount: 0, hasOlder: false },
};

const TOPUPS = {
  topupDestinations: {
    signerGas: { ss58Address: "fixture-signer", asset: "DOT", network: "Polkadot Asset Hub" },
    rewardBank: { ss58Address: "fixture-bank", asset: "USDC", network: "Polkadot Asset Hub" },
  },
};

describe("overnight ledger admin reads", () => {
  it("uses AVERRAY_OPS_TOKEN for every admin read without invoking SIWE", async () => {
    const login = vi.fn(async () => ({ token: "siwe-session" }));
    const getSession = createAdminReadSessionProvider({
      staticToken: "ops-service-token",
      getSiweSession: login,
    });
    const seenAuthorization: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
      const address = String(url);
      const body = address.includes("auth/session")
        ? { wallet: "0x062d000000000000000000000000000000002a8a", capabilities: ["ops:view", "admin:status"] }
        : address.includes("topup-destinations")
        ? TOPUPS
        : address.includes("overnight-ledger")
          ? LEDGER
          : address.includes("arrivals/timeline")
            ? { collectionSince: "2026-08-24T00:00:00.000Z" }
            : { collectionSince: "2026-08-24T00:00:00.000Z" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const [feed] = await Promise.all([readOvernightLedgerFeed({
      baseUrl: "https://api.example.test",
      window: "24h",
      getSession,
      fetchImpl,
    }), readAdminDemandFeed({
      baseUrl: "https://api.example.test",
      window: "48h",
      limit: 50,
      getSession,
      fetchImpl,
    })]);

    expect(login).not.toHaveBeenCalled();
    expect(seenAuthorization).toEqual(Array(5).fill("Bearer ops-service-token"));
    expect(feed.ledger.state).toBe("live");
    expect(feed.topupDestinations.state).toBe("live");
    expect(feed.readIdentity).toEqual({
      state: "live",
      data: {
        wallet: "0x062d000000000000000000000000000000002a8a",
        scopes: ["admin:status", "ops:view"],
        source: "static_token",
      },
    });
    expect(JSON.stringify(feed)).not.toContain("ops-service-token");
  });

  it("falls back to the existing SIWE session when AVERRAY_OPS_TOKEN is unset", async () => {
    const login = vi.fn(async () => ({ token: "siwe-session" }));
    const getSession = createAdminReadSessionProvider({ staticToken: "", getSiweSession: login });
    expect(await getSession()).toEqual({ token: "siwe-session", source: "siwe" });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("classifies HTTP 403 as the named unauthorized state rather than an empty ledger", async () => {
    const feed = await readOvernightLedgerFeed({
      baseUrl: "https://api.example.test",
      window: "48h",
      getSession: async () => ({ token: "wrong-scope" }),
      fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
    });

    expect(feed.ledger).toEqual({
      state: "unauthorized",
      reason: "feed unauthorized — monitor token lacks ops:view",
    });
    expect(feed.topupDestinations).toEqual(feed.ledger);
    expect(feed.readIdentity).toEqual({
      state: "unauthorized",
      reason: "read identity unauthorized — monitor token was not accepted",
    });
  });

  it("keeps the monitor projection private and no-store", () => {
    const source = fs.readFileSync(path.resolve("services/slack-operator/src/index.ts"), "utf8");
    const routeStart = source.indexOf('url.pathname === "/monitor/overnight-ledger"');
    const routeEnd = source.indexOf("return;", source.indexOf("readOvernightLedgerFeed", routeStart));
    const route = source.slice(routeStart, routeEnd);
    expect(routeStart).toBeGreaterThan(0);
    expect(route).toContain("isMonitorAuthorized");
    expect(route).toContain("readOvernightLedgerFeed");
    expect(route).toContain('"cache-control", "private, no-store"');
  });

  it("plumbs AVERRAY_OPS_TOKEN through Compose without committing a value", () => {
    const compose = fs.readFileSync(path.resolve("ops/compose.yml"), "utf8");
    const example = fs.readFileSync(path.resolve("ops/.env.example"), "utf8");
    expect(compose).toContain("AVERRAY_OPS_TOKEN: ${AVERRAY_OPS_TOKEN:-}");
    expect(example).toMatch(/^AVERRAY_OPS_TOKEN=$/mu);
  });
});

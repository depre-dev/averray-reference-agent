import { describe, expect, it, vi } from "vitest";

import {
  BANK_MOVES_NOT_REPORTED,
  bankChangeText,
  openBankMovesCursor,
  readBankMoves,
  type BankMovesCursorState,
} from "../../services/slack-operator/src/bank-moves-feed.js";

const EXAMPLE_LINE =
  "+1.00 reserved · job pr-quanta-js-quanta-212 (git-patch-tests-v1) · 0x2e3c…91 regular (5 jobs, 3 settled, 1 rejected, 1 open, since Sep 28) · MCP, client \"claude-code\", stage claimed · claim expires 14:20Z, payout on merge";

const NOW = Date.parse("2026-10-13T14:00:00.000Z");

function cursor(): BankMovesCursorState {
  return openBankMovesCursor(NOW);
}

function page(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: "averray.admin.bank-moves.v1",
    generatedAt: "2026-10-13T14:00:00.000Z",
    since: { kind: "timestamp", value: "2026-10-12T14:00:00.000Z" },
    privacy: { containsNetworkIdentifiers: false, preAuthJoinedToWallet: false },
    unavailable: BANK_MOVES_NOT_REPORTED,
    moves: [{
      id: "reserve",
      at: "2026-10-13T14:00:00.000Z",
      txHash: "0xabc",
      kind: "reserve",
      line: EXAMPLE_LINE,
      wallet: { address: "0x2e3c000000000000000000000000000000000091", short: "0x2e3c…91", tag: "regular" },
    }],
    returnedCount: 1,
    limit: 50,
    hasMore: false,
    nextCursor: "reserve",
    gap: false,
    history: { complete: true, eventLogBounded: false },
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("bank move admin reads", () => {
  it("sends the ops bearer and keeps the backend line verbatim", async () => {
    const seen: Array<{ url: string; authorization: string }> = [];
    const result = await readBankMoves({
      baseUrl: "https://api.example.test/",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
        });
        return jsonResponse(page());
      }) as typeof fetch,
    });

    expect(seen).toEqual([{
      url: "https://api.example.test/admin/ops/bank-moves?since=2026-10-12T14%3A00%3A00.000Z&limit=50",
      authorization: "Bearer ops-service-token",
    }]);
    expect(result.reading).toEqual({
      state: "live",
      incomplete: false,
      moves: [{ id: "reserve", at: "2026-10-13T14:00:00.000Z", line: EXAMPLE_LINE }],
    });
    expect(JSON.stringify(result)).not.toContain("ops-service-token");
    expect(JSON.stringify(result)).not.toContain("0x2e3c000000000000000000000000000000000091");
    expect(bankChangeText(result.reading)).toEqual([
      "Recent bank moves:",
      EXAMPLE_LINE,
    ]);
  });

  it("polls the next page with the exclusive cursor and shows newest first", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (calls.length === 1) {
        return jsonResponse(page({
          hasMore: true,
          nextCursor: "older",
          moves: [{
            id: "older",
            at: "2026-10-13T13:00:00.000Z",
            line: "-1.00 settled · job not reported · 0x062d…8a self · not reported · not reported",
          }],
        }));
      }
      return jsonResponse(page({
        hasMore: false,
        nextCursor: "reserve",
        moves: [{ id: "reserve", at: "2026-10-13T14:00:00.000Z", line: EXAMPLE_LINE }],
      }));
    }) as typeof fetch;

    const first = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl,
      maxPages: 1,
    });
    expect(first.cursor.cursor).toBe("older");
    expect(first.reading).toMatchObject({ state: "live", incomplete: true });

    const second = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: first.cursor,
      accumulated: first.accumulated,
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl,
      maxPages: 1,
    });
    expect(calls[1]).toContain("since=older");
    expect(second.cursor.cursor).toBe("reserve");
    expect(second.reading).toEqual({
      state: "live",
      incomplete: false,
      moves: [
        { id: "reserve", at: "2026-10-13T14:00:00.000Z", line: EXAMPLE_LINE },
        {
          id: "older",
          at: "2026-10-13T13:00:00.000Z",
          line: "-1.00 settled · job not reported · 0x062d…8a self · not reported · not reported",
        },
      ],
    });
    expect(bankChangeText(second.reading)?.[1]).toBe(EXAMPLE_LINE);
  });

  it.each([404, 403, 401])("HTTP %s is not reported and is not an empty success", async (status) => {
    const previous = [{ id: "kept", at: "2026-10-13T12:00:00.000Z", line: EXAMPLE_LINE }];
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: { cursor: "kept", openedAt: "2026-10-12T14:00:00.000Z" },
      accumulated: previous,
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async () => new Response("no", { status })) as typeof fetch,
    });
    expect(result.reading).toEqual({ state: "unavailable", text: "not reported" });
    expect(result.cursor.cursor).toBe("kept");
    expect(result.accumulated).toEqual(previous);
    expect(JSON.stringify(result.reading)).not.toContain("moves");
    expect(JSON.stringify(result.reading)).not.toMatch(/"0"|empty/);
    expect(bankChangeText(result.reading)).toEqual(["Recent bank moves: not reported"]);
  });

  it("a timeout is not reported", async () => {
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      timeoutMs: 20,
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    expect(result.reading).toEqual({ state: "unavailable", text: "not reported" });
  });

  it("a network-identifier payload is refused", async () => {
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async () => jsonResponse(page({
        privacy: { containsNetworkIdentifiers: true, preAuthJoinedToWallet: false },
      }))) as typeof fetch,
    });
    expect(result.reading.state).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(EXAMPLE_LINE);
    expect(JSON.stringify(result)).not.toContain("ip");
  });

  it("an ip field on a move is refused without quoting the line", async () => {
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async () => jsonResponse(page({
        moves: [{
          id: "reserve",
          at: "2026-10-13T14:00:00.000Z",
          line: EXAMPLE_LINE,
          ip: "203.0.113.8",
        }],
      }))) as typeof fetch,
    });
    expect(result.reading).toEqual({ state: "unavailable", text: "not reported" });
    expect(JSON.stringify(result)).not.toContain("203.0.113.8");
    expect(JSON.stringify(result.reading)).not.toContain(EXAMPLE_LINE);
  });

  it("an unresolved bank account is not reported, even when moves were attached", async () => {
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async () => jsonResponse(page({
        unavailable: "reward_bank_account_unresolved",
        moves: [],
      }))) as typeof fetch,
    });
    expect(result.reading).toEqual({ state: "unavailable", text: "not reported" });
  });

  it("a measured empty window is not a zero", async () => {
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async () => jsonResponse(page({
        moves: [],
        returnedCount: 0,
        nextCursor: null,
      }))) as typeof fetch,
    });
    expect(result.reading).toEqual({ state: "live", moves: [], incomplete: false });
    expect(bankChangeText(result.reading)).toEqual(["Recent bank moves: none in window"]);
    expect(bankChangeText(result.reading)?.join("\n")).not.toMatch(/\b0\b/);
  });

  it("a gap with no lines stays not reported", async () => {
    const result = await readBankMoves({
      baseUrl: "https://api.example.test",
      cursor: cursor(),
      getSession: async () => ({ token: "ops-service-token" }),
      fetchImpl: vi.fn(async () => jsonResponse(page({ moves: [], gap: true, returnedCount: 0 }))) as typeof fetch,
    });
    expect(result.reading).toEqual({ state: "unavailable", text: "not reported" });
  });
});

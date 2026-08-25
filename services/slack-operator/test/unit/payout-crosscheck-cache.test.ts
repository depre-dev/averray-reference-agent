import { describe, expect, test } from "vitest";

import {
  DEFAULT_CROSSCHECK_INTERVAL_MS,
  DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS,
  createCrossCheckCache,
  type CrossCheckRun,
} from "../../src/payout-crosscheck-cache.js";

const PRIMARY = { host: "primary.example", count: 18 };
const SECONDARY = { host: "secondary.example", count: 18 };
const THROTTLED: CrossCheckRun = {
  primary: PRIMARY,
  secondary: null,
  secondaryReason: "RPC endpoint throttled (HTTP 429)",
};
const AGREE: CrossCheckRun = { primary: PRIMARY, secondary: SECONDARY };
const DISAGREE: CrossCheckRun = {
  primary: PRIMARY,
  secondary: { ...SECONDARY, count: 17 },
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("payout cross-check retry cadence", () => {
  test("a failed attempt does not consume the success interval", async () => {
    let attempts = 0;
    const cache = createCrossCheckCache({
      configured: true,
      run: async () => { attempts += 1; return THROTTLED; },
    });

    cache.maybeRefresh(0);
    await settle();
    expect(attempts).toBe(1);
    expect(cache.read()).toMatchObject({
      status: "unavailable",
      reason: "throttled",
      retryAtMs: DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS,
    });

    cache.maybeRefresh(DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS - 1);
    await settle();
    expect(attempts).toBe(1);

    cache.maybeRefresh(31 * 60 * 1000);
    await settle();
    expect(attempts).toBe(2);
  });

  test("retry backoff is monotonic and capped at the success interval", async () => {
    const attemptTimes: number[] = [];
    let nowMs = 0;
    const cache = createCrossCheckCache({
      configured: true,
      intervalMs: 8_000,
      retryIntervalMs: 1_000,
      run: async () => { attemptTimes.push(nowMs); return THROTTLED; },
    });

    for (const tick of [0, 999, 1_000, 2_999, 3_000, 6_999, 7_000, 14_999, 15_000]) {
      nowMs = tick;
      cache.maybeRefresh(tick);
      await settle();
    }

    expect(attemptTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    expect(attemptTimes.slice(1).map((at, index) => at - attemptTimes[index])).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
    ]);
  });

  test("a successful comparison clears backoff and restarts the seven-day clock", async () => {
    const outcomes = [THROTTLED, AGREE, THROTTLED, AGREE];
    let attempts = 0;
    const cache = createCrossCheckCache({
      configured: true,
      run: async () => outcomes[attempts++]!,
    });

    cache.maybeRefresh(0);
    await settle();
    cache.maybeRefresh(DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS);
    await settle();
    expect(cache.read().status).toBe("agree");
    expect(attempts).toBe(2);

    const successAt = DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS;
    cache.maybeRefresh(successAt + DEFAULT_CROSSCHECK_INTERVAL_MS - 1);
    await settle();
    expect(attempts).toBe(2);

    const nextLongRun = successAt + DEFAULT_CROSSCHECK_INTERVAL_MS;
    cache.maybeRefresh(nextLongRun);
    await settle();
    expect(attempts).toBe(3);
    cache.maybeRefresh(nextLongRun + DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS);
    await settle();
    expect(attempts).toBe(4);
    expect(cache.read().status).toBe("agree");
  });

  test("a disagreement is a successful comparison and resets retry backoff", async () => {
    const outcomes = [THROTTLED, DISAGREE, AGREE];
    let attempts = 0;
    const cache = createCrossCheckCache({
      configured: true,
      run: async () => outcomes[attempts++]!,
    });

    cache.maybeRefresh(0);
    await settle();
    cache.maybeRefresh(DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS);
    await settle();
    expect(cache.read()).toMatchObject({ status: "disagree" });
    expect(cache.read()).not.toHaveProperty("retryAtMs");

    cache.maybeRefresh(2 * DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS);
    await settle();
    expect(attempts).toBe(2);

    cache.maybeRefresh(DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS + DEFAULT_CROSSCHECK_INTERVAL_MS);
    await settle();
    expect(attempts).toBe(3);
  });

  test("an always-failing provider is attempted at most nine times in one week", async () => {
    let attempts = 0;
    const cache = createCrossCheckCache({
      configured: true,
      run: async () => { attempts += 1; return THROTTLED; },
    });

    for (let nowMs = 0; nowMs <= DEFAULT_CROSSCHECK_INTERVAL_MS; nowMs += 60_000) {
      cache.maybeRefresh(nowMs);
      await settle();
    }

    expect(attempts).toBeLessThanOrEqual(9);
  });
});

import { describe, expect, it } from "vitest";

import { decideDiskHeadroom, readDiskUsage } from "../../services/slack-operator/src/disk-headroom.js";

const GB = 1024 ** 3;
const usage = (totalGb: number, freeGb: number) => ({
  totalBytes: totalGb * GB,
  availableBytes: freeGb * GB,
});

describe("decideDiskHeadroom", () => {
  const floors = { minFreeGb: 10, warnFreeGb: 25 };

  it("the live box today is comfortably ok", () => {
    // Measured 2026-07-31 after the prune: 155 GiB free of 193.
    const r = decideDiskHeadroom({ usage: usage(193, 155), ...floors });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("155.0 GiB free of 193 GiB");
  });

  it("the SAME box before the prune would also have been ok — 66% is not an alarm", () => {
    // 68 GiB free. The percentage looked scary; absolute headroom was fine,
    // which is exactly why this judges bytes and not percent.
    expect(decideDiskHeadroom({ usage: usage(193, 68), ...floors }).status).toBe("ok");
  });

  it("degrades under the warning line", () => {
    const r = decideDiskHeadroom({ usage: usage(193, 20), ...floors });
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("under the 25 GiB warning line");
  });

  it("goes RED under the floor and says writes are at risk", () => {
    const r = decideDiskHeadroom({ usage: usage(193, 4), ...floors });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("below the 10 GiB floor");
    expect(r.detail).toContain("writes are at risk");
  });

  // Percentage is the intuitive number and the wrong one.
  it("PERCENT DOES NOT DECIDE: 5% of a huge disk is healthy…", () => {
    const r = decideDiskHeadroom({ usage: usage(2000, 100), ...floors });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("95% used"); // alarming percent, real comfort
  });

  it("…and 20% of a small disk is RED", () => {
    const r = decideDiskHeadroom({ usage: usage(20, 4), ...floors });
    expect(r.status).toBe("red"); // reassuring percent, actually failing
    expect(r.detail).toContain("80% used");
  });

  it("UNREADABLE is degraded, never ok — a probe that cannot see must not report calm", () => {
    const r = decideDiskHeadroom({ usage: { totalBytes: null, availableBytes: null }, ...floors });
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("NOT verified");
  });

  it("a half-read measurement is also unreadable, not a guess", () => {
    expect(decideDiskHeadroom({ usage: { totalBytes: 100 * GB, availableBytes: null }, ...floors }).status)
      .toBe("degraded");
  });

  it("boundary: exactly at the floor is not yet red", () => {
    expect(decideDiskHeadroom({ usage: usage(193, 10), ...floors }).status).toBe("degraded");
    expect(decideDiskHeadroom({ usage: usage(193, 9.99), ...floors }).status).toBe("red");
  });

  it("a warn line at or below the floor is ignored rather than inverting the tiers", () => {
    const r = decideDiskHeadroom({ usage: usage(193, 15), minFreeGb: 20, warnFreeGb: 10 });
    expect(r.status).toBe("red"); // the floor still governs; a bad warn cannot mask it
  });

  it("floors of 0 mean the probe can only ever report ok — the documented footgun", () => {
    expect(decideDiskHeadroom({ usage: usage(193, 0.5), minFreeGb: 0, warnFreeGb: 0 }).status).toBe("ok");
  });
});

describe("readDiskUsage", () => {
  it("reads the real filesystem it runs on", () => {
    const u = readDiskUsage("/");
    expect(u.totalBytes).toBeGreaterThan(0);
    expect(u.availableBytes).toBeGreaterThanOrEqual(0);
    expect(u.availableBytes!).toBeLessThanOrEqual(u.totalBytes!);
  });

  it("a nonexistent path is unreadable — not a throw, and not a zero-free false alarm", () => {
    const u = readDiskUsage("/definitely/not/a/real/path/xyzzy");
    expect(u).toEqual({ totalBytes: null, availableBytes: null });
    expect(decideDiskHeadroom({ usage: u, minFreeGb: 10, warnFreeGb: 25 }).status).toBe("degraded");
  });
});

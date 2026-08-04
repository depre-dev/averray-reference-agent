import { describe, expect, test } from "vitest";

import { normalizeBankFeed, readBankFeed } from "../../src/bank-feed-fetch.js";

const good = {
  position: { raw: "0", source: "erc20:0x2ec4…fa93.balanceOf(0x98f0…b68e)", readAtMs: 1_785_900_000_000 },
  float: { raw: "149412", source: "substrate_tokens:22", readAtMs: 1_785_900_000_000 },
  postage: { raw: "2697000000", source: "substrate_system:1yKNU414…", readAtMs: 1_785_900_000_000 },
  requests: { items: [], readAtMs: 1_785_900_000_000, lastError: null },
  calibration: null,
};

describe("not wired is not broken", () => {
  test("no URL yields no feed AND no reason — the lane simply does not exist", () => {
    // A lane nobody configured must not produce a line complaining about it.
    return readBankFeed({ url: "", fetchImpl: (() => { throw new Error("must not fetch"); }) as never })
      .then((r) => {
        expect(r.feed).toBeUndefined();
        expect(r.reason).toBeUndefined();
      });
  });

  test("a CONFIGURED feed that fails gets a reason", async () => {
    const r = await readBankFeed({
      url: "http://backend:8787/monitor/bank-feed",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never,
    });
    expect(r.feed).toBeUndefined();
    expect(r.reason).toContain("ECONNREFUSED");
  });

  test("a non-2xx names the status", async () => {
    const r = await readBankFeed({
      url: "http://backend:8787/monitor/bank-feed",
      fetchImpl: (async () => ({ ok: false, status: 503 })) as never,
    });
    expect(r.reason).toContain("503");
  });
});

describe("nothing that crossed the network is trusted", () => {
  test("a well-formed payload passes through intact", () => {
    const r = normalizeBankFeed(good);
    expect(r.reason).toBeUndefined();
    expect(r.feed!.float.raw).toBe("149412");
    expect(r.feed!.position.readAtMs).toBe(1_785_900_000_000);
  });

  test("a NUMERIC raw is refused, not coerced", () => {
    // The dangerous case: a number renders fine, having already lost the
    // precision the decimal string existed to preserve. 149412 survives, but a
    // 30-digit balance would not, and nothing on screen would show it.
    const r = normalizeBankFeed({ ...good, float: { ...good.float, raw: 149412 } });
    expect(r.feed).toBeUndefined();
    expect(r.reason).toContain("float.raw must be a decimal string");
  });

  test("each rejection names its field, so the reader knows which repo to open", () => {
    expect(normalizeBankFeed({ ...good, position: undefined }).reason).toContain("position");
    expect(normalizeBankFeed({ ...good, postage: { ...good.postage, source: "" } }).reason).toContain("postage");
    expect(normalizeBankFeed({ ...good, requests: { items: "nope", readAtMs: 1 } }).reason).toContain("requests.items");
  });

  test("a request entry missing overdue is refused rather than defaulted", () => {
    // Defaulting `overdue` to false would invent an all-clear on the stuck-
    // pending alarm — the exact failure the section provenance exists to stop.
    const r = normalizeBankFeed({
      ...good,
      requests: { items: [{ id: "req-1", phase: "leg1-dispatched", ageSeconds: 10 }], readAtMs: 1 },
    });
    expect(r.feed).toBeUndefined();
    expect(r.reason).toContain("overdue");
  });

  test("an unknown phase passes through verbatim", () => {
    const r = normalizeBankFeed({
      ...good,
      requests: {
        items: [{ id: "req-1", kind: "deposit", phase: "timing-unknown", ageSeconds: 0, overdue: true }],
        readAtMs: 1,
      },
    });
    expect(r.feed!.requests.items[0]!.phase).toBe("timing-unknown");
  });

  test("terminal reconciliation crosses the boundary without a raw recovery-slot receivable", () => {
    const r = normalizeBankFeed({
      ...good,
      requests: {
        items: [{
          id: "req-terminal",
          kind: "deposit",
          phase: "terminal",
          status: "failed",
          ageSeconds: 100,
          overdue: false,
          reconciliation: {
            stagedRaw: "150000",
            actualTreasuryReturnRaw: "130200",
            leg1TransferFeeRaw: "525",
            trappedWriteOff3Raw: "17932",
            recoveryReturnFeeRaw: "1343",
            unexplainedRaw: "0",
            finalRawRecoverySlotResidueRaw: "19800",
            artifactLabel: "v2.1 accounting artifact, known-unrecoverable",
            rawRecoveryAssetsOutstandingRaw: "150000",
          },
        }],
        readAtMs: 1,
      },
    });
    expect(r.feed!.requests.items[0]!.reconciliation).toEqual({
      stagedRaw: "150000",
      actualTreasuryReturnRaw: "130200",
      leg1TransferFeeRaw: "525",
      trappedWriteOff3Raw: "17932",
      recoveryReturnFeeRaw: "1343",
      unexplainedRaw: "0",
      finalRawRecoverySlotResidueRaw: "19800",
      artifactLabel: "v2.1 accounting artifact, known-unrecoverable",
    });
    expect(r.feed!.requests.items[0]!.reconciliation).not.toHaveProperty("rawRecoveryAssetsOutstandingRaw");
  });
});

describe("a malformed calibration is dropped, never repaired", () => {
  test("a zero or negative proof is discarded", () => {
    for (const provenRaw of ["0", "-5"]) {
      const r = normalizeBankFeed({
        ...good,
        calibration: { provenAtMs: 1, provenRaw, provenSource: good.position.source },
      });
      expect(r.feed!.calibration ?? null).toBeNull();
    }
  });

  test("a proof with no source is discarded", () => {
    const r = normalizeBankFeed({ ...good, calibration: { provenAtMs: 1, provenRaw: "100000", provenSource: "" } });
    expect(r.feed!.calibration ?? null).toBeNull();
  });

  test("dropping it costs a zero reading as unverified — the conservative direction", () => {
    // Repairing a calibration would mean inventing the proof that a read path
    // works, which is the one thing the record exists to refuse.
    const r = normalizeBankFeed({ ...good, calibration: { garbage: true } });
    expect(r.feed).toBeDefined();
    expect(r.feed!.calibration ?? null).toBeNull();
  });

  test("a good proof survives", () => {
    const r = normalizeBankFeed({
      ...good,
      calibration: { provenAtMs: 1, provenRaw: "100000", provenSource: good.position.source },
    });
    expect(r.feed!.calibration!.provenRaw).toBe("100000");
  });
});

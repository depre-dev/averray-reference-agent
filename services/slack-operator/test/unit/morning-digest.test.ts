// The digest's contract: once per LOCAL day, at or after the chosen time,
// quoting only strings other systems decided.
import { describe, expect, test } from "vitest";

import {
  buildMorningDigest,
  digestDue,
  digestFactStrings,
  localStamp,
  readDigestSchedule,
  type DigestProbe,
} from "../../src/morning-digest.js";

const ZURICH = "Europe/Zurich";
// 2026-08-05T22:30Z. Zurich is UTC+2 in August, so LOCALLY this is already
// 2026-08-06 00:30 — the date-boundary case a UTC-naive implementation gets
// wrong in exactly the direction that double-sends.
const LATE_EVENING_UTC = Date.parse("2026-08-05T22:30:00Z");
const MORNING = Date.parse("2026-08-06T06:30:00Z"); // 08:30 in Zurich

const enabled = { enabled: true, hour: 8, minute: 0, timeZone: ZURICH };

describe("the schedule is config, and fail-closed", () => {
  test("off by default — a scheduled message is armed deliberately", () => {
    expect(readDigestSchedule({}).enabled).toBe(false);
  });

  test("armed with defaults: 08:00 Europe/Zurich", () => {
    const s = readDigestSchedule({ BUZZ_MORNING_DIGEST: "1" });
    expect(s).toMatchObject({ enabled: true, hour: 8, minute: 0, timeZone: ZURICH });
  });

  test("an invalid time DISABLES with a named problem — never a guessed hour", () => {
    const s = readDigestSchedule({ BUZZ_MORNING_DIGEST: "1", BUZZ_DIGEST_TIME: "8am" });
    expect(s.enabled).toBe(false);
    expect(s.problem).toContain('"8am"');
  });

  test("an invalid zone DISABLES with a named problem — never a guessed clock", () => {
    const s = readDigestSchedule({ BUZZ_MORNING_DIGEST: "1", BUZZ_DIGEST_TZ: "Mars/Olympus" });
    expect(s.enabled).toBe(false);
    expect(s.problem).toContain("Mars/Olympus");
  });
});

describe("once per local day, at or after the time", () => {
  test("before the hour: not due", () => {
    const d = digestDue({ nowMs: LATE_EVENING_UTC, schedule: enabled, lastSentLocalDate: "2026-08-05" });
    // 00:30 local on the 6th — a new day, but hours before 08:00.
    expect(d.due).toBe(false);
    expect(d.localDate).toBe("2026-08-06");
  });

  test("after the hour on a fresh day: due, stamped with the real local time", () => {
    const d = digestDue({ nowMs: MORNING, schedule: enabled, lastSentLocalDate: "2026-08-05" });
    expect(d).toMatchObject({ due: true, localDate: "2026-08-06", localTime: "08:30" });
  });

  test("already sent today: never again, whatever restarts happen", () => {
    const d = digestDue({ nowMs: MORNING, schedule: enabled, lastSentLocalDate: "2026-08-06" });
    expect(d.due).toBe(false);
  });

  test("down at 08:00 → fires late rather than not at all", () => {
    const lateAfternoon = Date.parse("2026-08-06T14:07:00Z"); // 16:07 local
    const d = digestDue({ nowMs: lateAfternoon, schedule: enabled, lastSentLocalDate: "2026-08-05" });
    expect(d).toMatchObject({ due: true, localTime: "16:07" });
  });

  test("disabled never fires, even past the hour", () => {
    const d = digestDue({ nowMs: MORNING, schedule: { ...enabled, enabled: false }, lastSentLocalDate: null });
    expect(d.due).toBe(false);
  });

  test("the UTC/local date boundary is decided in the LOCAL zone", () => {
    // At 22:30Z it is already tomorrow in Zurich. A UTC-date dedupe would call
    // this "still 2026-08-05" and then send twice on the 6th.
    expect(localStamp(LATE_EVENING_UTC, ZURICH).date).toBe("2026-08-06");
    expect(localStamp(LATE_EVENING_UTC, "UTC").date).toBe("2026-08-05");
  });
});

describe("the message quotes; it does not opine", () => {
  const probes: DigestProbe[] = [
    { name: "money_path", status: "ok", detail: "settled24h 16 (0 stuck, 0 failed)" },
    { name: "signer_liquidity", status: "ok", detail: "gas 7.2018 DOT, reward bank 10.20 USDC" },
    { name: "credential_expiry", status: "ok", detail: "3 TLS certs · no tokens watched, soonest expiry 37d" },
    { name: "chain_height", status: "ok", detail: "block #19,083,248" },
  ];
  const base = {
    localDate: "2026-08-06",
    localTime: "08:00",
    timeZone: ZURICH,
    network: "mainnet",
    verdictHeadline: "money is moving and proven on-chain",
    probes,
  };

  test("a clean morning: lock-screen opener, verdict quoted, the probes' own words", () => {
    const text = buildMorningDigest({ ...base, bankRequests: { text: "no requests in flight", tone: "ok" } });
    expect(text.split("\n")[0]).toBe("Good morning — all 4 probes green on Averray mainnet.");
    expect(text).toContain('The board reads: "money is moving and proven on-chain"');
    // No human stamp supplied → the ISO date stands in; nothing is invented.
    expect(text).toContain("2026-08-06 08:00 (Europe/Zurich)");
    expect(text).toContain("Money: settled24h 16 (0 stuck, 0 failed)");
    expect(text).toContain("Credentials: 3 TLS certs · no tokens watched");
    expect(text).toContain("Bank: no requests in flight");
    expect(text).not.toContain("Needs attention");
    expect(text.endsWith("Nothing is waiting on you.")).toBe(true);
  });

  test("the human stamp renders when the caller supplies it", () => {
    const text = buildMorningDigest({ ...base, weekday: "Thursday", humanDate: "6 Aug" });
    expect(text).toContain("Thursday 6 Aug, 08:00 (Europe/Zurich)");
  });

  test("greets by when it ACTUALLY fired — a late catch-up is not 'morning'", () => {
    const text = buildMorningDigest({ ...base, localTime: "16:07" });
    expect(text.startsWith("Good afternoon — ")).toBe(true);
  });

  test("an absent probe contributes NO line — absence is not zero", () => {
    const text = buildMorningDigest({ ...base, probes: probes.filter((p) => p.name !== "money_path") });
    expect(text).not.toContain("Money:");
  });

  test("no bank lane, no bank line — the rule every surface follows", () => {
    const text = buildMorningDigest({ ...base, bankRequests: null });
    expect(text).not.toContain("Bank:");
  });

  test("everything not-ok is quoted under 'Needs attention', red first — the hold may never have announced it", () => {
    const text = buildMorningDigest({
      ...base,
      probes: [
        ...probes,
        { name: "capabilities", status: "degraded", detail: "External posting is staged. (external_posting_staged)" },
        { name: "api_latency", status: "red", detail: "/health 4100ms" },
      ],
    });
    expect(text.split("\n")[0]).toBe("Good morning — 2 of 6 probes need attention on Averray mainnet.");
    expect(text).toContain("Needs attention:");
    expect(text).toContain("⚠ Capabilities — External posting is staged.");
    expect(text).toContain("✗ API latency — /health 4100ms");
    expect(text.indexOf("✗ API latency")).toBeLessThan(text.indexOf("⚠ Capabilities"));
    expect(text.endsWith("One item needs you now.")).toBe(true);
  });

  test("singular grammar when a lone probe wants eyes", () => {
    const text = buildMorningDigest({
      ...base,
      probes: [{ name: "signer_liquidity", status: "degraded", detail: "gas ×1.1 — near floor" }],
    });
    expect(text.split("\n")[0]).toBe("Good morning — 1 of 1 probe needs attention on Averray mainnet.");
    expect(text.endsWith("Worth a look when you're at the desk — nothing is on fire.")).toBe(true);
  });

  test("a red bank tone summons the operator even on a green board", () => {
    const text = buildMorningDigest({
      ...base,
      bankRequests: { text: "1 OVERDUE — leg2-dispatched for 8.7h", tone: "red" },
    });
    expect(text.endsWith("One item needs you now.")).toBe(true);
  });

  test("the closing never out-calms the verdict — red verdict on green probes summons", () => {
    // floor-breach / payout-shortfall derive from pools and payout evidence,
    // not probes: every probe green and the verdict red is a REAL state.
    const text = buildMorningDigest({ ...base, verdictReason: "floor-breach", verdictTone: "red" });
    expect(text.split("\n")[0]).toBe("Good morning — all 4 probes green on Averray mainnet.");
    expect(text.endsWith("The verdict line above needs you now.")).toBe(true);
  });

  test("non-nominal, non-red verdict on green probes points at the verdict", () => {
    const text = buildMorningDigest({ ...base, verdictReason: "pool-draining", verdictTone: "degraded" });
    expect(text.endsWith("The probes are green, but the verdict line above is the one to read.")).toBe(true);
  });

  test("'nothing is on fire' is only said when the verdict agrees", () => {
    const text = buildMorningDigest({
      ...base,
      verdictReason: "pool-draining",
      verdictTone: "degraded",
      probes: [...probes, { name: "capabilities", status: "degraded", detail: "x staged" }],
    });
    expect(text.endsWith("Worth a look when you're at the desk — and read the verdict line above.")).toBe(true);
  });

  test("a nominal verdict keeps the calm closings", () => {
    const text = buildMorningDigest({ ...base, verdictReason: "nominal", verdictTone: "ok" });
    expect(text.endsWith("Nothing is waiting on you.")).toBe(true);
  });

  test("bank tone 'awaiting' is a blind instrument, not a summons", () => {
    const text = buildMorningDigest({
      ...base,
      bankRequests: { text: "aUSDC not read yet", tone: "awaiting" },
    });
    expect(text.endsWith("Nothing is waiting on you.")).toBe(true);
  });
});

describe("digestDue carries the human stamp beside the dedupe date", () => {
  test("weekday and short date come from the same instant, same zone", () => {
    const d = digestDue({ nowMs: MORNING, schedule: enabled, lastSentLocalDate: null });
    expect(d.weekday).toBe("Thursday");
    expect(d.humanDate).toBe("6 Aug");
  });
});

describe("digestFactStrings — the strings Hermes may not lose", () => {
  test("fact lines, every not-ok detail, and the bank line", () => {
    const facts = digestFactStrings({
      localDate: "2026-08-06",
      localTime: "08:00",
      timeZone: ZURICH,
      network: "mainnet",
      verdictHeadline: "x",
      probes: [
        { name: "money_path", status: "ok", detail: "settled24h 16 (0 stuck, 0 failed)" },
        { name: "product_api", status: "red", detail: "health check failing for 12m" },
      ],
      bankRequests: { text: "1 open request, staged on-chain", tone: "ok" },
    });
    expect(facts).toContain("settled24h 16 (0 stuck, 0 failed)");
    expect(facts).toContain("health check failing for 12m");
    expect(facts).toContain("1 open request, staged on-chain");
  });
});

// ── The digest during a blind window ────────────────────────────────────────
//
// A container DNS failure straddling the send time used to open with "4 of 9
// probes need attention" and list four findings — about a product none of those
// four probes had managed to ask. One network fault, four accusations.
describe("probes that took no reading are separated from probes needing attention", () => {
  const unreadable = (name: string, subject: string): DigestProbe => ({
    name,
    status: "degraded",
    reading: "unknown",
    detail: `${subject} unknown — product /health not readable from here — DNS resolution failed (ENOTFOUND)`,
  });

  const base = {
    localDate: "2026-08-06",
    localTime: "08:00",
    timeZone: ZURICH,
    network: "mainnet",
    verdictHeadline: "MONEY PATH UNKNOWN +3",
    probes: [
      { name: "signer_liquidity", status: "ok", detail: "gas 7.2018 DOT, reward bank 10.20 USDC" },
      { name: "credential_expiry", status: "ok", detail: "3 TLS certs · no tokens watched, soonest expiry 37d" },
      unreadable("money_path", "settlement state"),
      unreadable("chain_height", "chain height"),
    ] as DigestProbe[],
  };

  test("does not count them as needing attention", () => {
    const text = buildMorningDigest(base);
    expect(text).not.toContain("need attention");
    expect(text.split("\n")[0]).toBe("Good morning — 2 of 4 probes green on Averray mainnet; 2 could not be read.");
  });

  test("names them anyway, under their own heading", () => {
    // Excluded from the count, never from the message: an instrument that
    // cannot see is the first thing the operator needs to know.
    const text = buildMorningDigest(base);
    expect(text).toContain("Could not be read (no evidence either way):");
    expect(text).toContain("· Money path — settlement state unknown");
    expect(text).toContain("ENOTFOUND");
    expect(text).not.toContain("Needs attention");
  });

  test("an observed degradation still needs attention alongside them", () => {
    const text = buildMorningDigest({
      ...base,
      probes: [...base.probes, { name: "disk_headroom", status: "degraded", detail: "4.1GB free" }],
    });
    expect(text.split("\n")[0]).toContain("1 of 5 probes needs attention");
    expect(text).toContain("Needs attention:");
    expect(text).toContain("Disk headroom — 4.1GB free");
    expect(text).toContain("Could not be read (no evidence either way):");
  });

  test("a red we could not read is still a red — it is not filtered away", () => {
    const text = buildMorningDigest({
      ...base,
      probes: [
        { name: "product_api", status: "red", reading: "unknown", detail: "probe cannot reach https://api.averray.com/health — DNS resolution failed (ENOTFOUND) · 3 consecutive checks" },
      ],
    });
    expect(text).toContain("Needs attention:");
    expect(text).toContain("Product API — probe cannot reach");
  });
});

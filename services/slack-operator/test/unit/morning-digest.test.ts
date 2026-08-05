// The digest's contract: once per LOCAL day, at or after the chosen time,
// quoting only strings other systems decided.
import { describe, expect, test } from "vitest";

import {
  buildMorningDigest,
  digestDue,
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

  test("a clean morning: header, verdict, counts, and the probes' own words", () => {
    const text = buildMorningDigest({ ...base, bankRequests: { text: "no requests in flight", tone: "ok" } });
    expect(text).toContain("MORNING DIGEST · 2026-08-06 08:00 Europe/Zurich · AVERRAY MAINNET");
    expect(text).toContain("money is moving and proven on-chain");
    expect(text).toContain("PROBES 4 ok / 0 red of 4");
    expect(text).toContain("FLOW settled24h 16 (0 stuck, 0 failed)");
    expect(text).toContain("CREDS 3 TLS certs · no tokens watched");
    expect(text).toContain("BANK no requests in flight");
    expect(text).not.toContain("ATTENTION");
  });

  test("an absent probe contributes NO line — absence is not zero", () => {
    const text = buildMorningDigest({ ...base, probes: probes.filter((p) => p.name !== "money_path") });
    expect(text).not.toContain("FLOW");
  });

  test("no bank lane, no BANK line — the rule every surface follows", () => {
    const text = buildMorningDigest({ ...base, bankRequests: null });
    expect(text).not.toContain("BANK");
  });

  test("everything not-ok is quoted under ATTENTION — the hold may never have announced it", () => {
    const text = buildMorningDigest({
      ...base,
      probes: [
        ...probes,
        { name: "capabilities", status: "degraded", detail: "External posting is staged. (external_posting_staged)" },
        { name: "api_latency", status: "red", detail: "/health 4100ms" },
      ],
    });
    expect(text).toContain("ATTENTION");
    expect(text).toContain("⚠ capabilities: External posting is staged.");
    expect(text).toContain("✗ api_latency: /health 4100ms");
    expect(text).toContain("PROBES 4 ok / 1 red of 6");
  });
});

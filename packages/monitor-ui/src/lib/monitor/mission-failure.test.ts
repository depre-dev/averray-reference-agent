import { describe, expect, test } from "vitest";
import {
  cleanFailureText,
  summarizeMissionFailure,
  missionFailureLine,
} from "./mission-failure.js";

// The real-world dump shape from the task: multi-line, pipes, box-drawing.
const RAW_PLAYWRIGHT =
  "Executable doesn't exist at /home/appuser/.cache/ms-playwright/chromium-1140/chrome-linux/chrome\n" +
  "│ Video rendering requires ffmpeg binary │\n" +
  "╔══════════════════════╗\n" +
  "║ npx playwright install ffmpeg ║\n" +
  "╚══════════════════════╝\n" +
  "| | |";

describe("cleanFailureText", () => {
  test("strips box-drawing, pipes, and collapses whitespace/newlines", () => {
    const cleaned = cleanFailureText(RAW_PLAYWRIGHT);
    // No box-drawing, no pipes, no newlines survive.
    expect(cleaned).not.toMatch(/[─-▟]/);
    expect(cleaned).not.toContain("|");
    expect(cleaned).not.toContain("\n");
    expect(cleaned).not.toMatch(/\s{2,}/); // whitespace collapsed
    expect(cleaned.startsWith("Executable doesn't exist")).toBe(true);
  });

  test("strips ANSI escape sequences", () => {
    const ansi = "\x1b[31mError:\x1b[0m navigation \x1b[1mtimed out\x1b[0m";
    expect(cleanFailureText(ansi)).toBe("Error: navigation timed out");
  });

  test("strips other control characters", () => {
    expect(cleanFailureText("a\x00b\x07c\x7f")).toBe("a b c");
  });

  test("handles empty / non-string input", () => {
    expect(cleanFailureText("")).toBe("");
    expect(cleanFailureText(undefined)).toBe("");
    expect(cleanFailureText(null)).toBe("");
  });
});

describe("summarizeMissionFailure — known-failure mapping", () => {
  const cases: { raw: string; reason: string }[] = [
    { raw: RAW_PLAYWRIGHT, reason: "browser binary not installed" },
    { raw: "Error: Video rendering requires ffmpeg binary; run npx playwright install ffmpeg", reason: "ffmpeg not installed (video capture)" },
    { raw: "page.goto failed: server responded 401 Unauthorized", reason: "authentication failed (401)" },
    { raw: "Request failed with status 403 Forbidden", reason: "access forbidden (403)" },
    { raw: "Timeout 30000ms exceeded waiting for navigation", reason: "timed out" },
    { raw: "<--- Last few GCs ---> JavaScript heap out of memory", reason: "runner ran out of memory" },
    { raw: "Mission did not run — runner pool offline.", reason: "runner offline — mission did not run" },
    { raw: "net::ERR_CONNECTION_REFUSED at https://staging.averray.com", reason: "could not reach the target" },
  ];
  for (const { raw, reason } of cases) {
    test(`maps "${raw.slice(0, 32)}…" → ${reason}`, () => {
      const summary = summarizeMissionFailure(raw);
      expect(summary.reason).toBe(reason);
      expect(summary.friendly).toBe(true);
    });
  }

  test("browser-binary check wins over the ffmpeg check when both appear", () => {
    // The canonical dump mentions ffmpeg too; the primary failure is the
    // missing browser binary, which must win (ordering).
    expect(summarizeMissionFailure(RAW_PLAYWRIGHT).reason).toBe("browser binary not installed");
  });
});

describe("summarizeMissionFailure — fallback", () => {
  test("unknown failure → cleaned (no box-drawing), not friendly; first sentence kept", () => {
    const raw = "Some novel failure happened here. Extra detail │ more noise";
    const summary = summarizeMissionFailure(raw);
    expect(summary.friendly).toBe(false);
    // First sentence is the readable lead-in.
    expect(summary.reason).toBe("Some novel failure happened here.");
    expect(summary.reason).not.toContain("│");
  });

  test("unknown single-line failure keeps the cleaned text (box-drawing gone), capped", () => {
    const raw = "Weird runner state │ partial output │ retry advised";
    const summary = summarizeMissionFailure(raw);
    expect(summary.friendly).toBe(false);
    expect(summary.reason).not.toContain("│");
    // No sentence boundary → the whole cleaned line is the reason.
    expect(summary.reason).toBe("Weird runner state partial output retry advised");
  });

  test("strips a leading stderr:/error: label in the fallback", () => {
    expect(summarizeMissionFailure("stderr: something broke unexpectedly").reason).toBe(
      "something broke unexpectedly",
    );
  });

  test("caps an overlong reason", () => {
    const long = `A${"x".repeat(400)}`;
    const summary = summarizeMissionFailure(long);
    expect(summary.reason.length).toBeLessThanOrEqual(120);
    expect(summary.reason.endsWith("…")).toBe(true);
  });

  test("empty input → honest placeholder, not fabricated", () => {
    expect(summarizeMissionFailure("").reason).toBe("no failure detail reported");
    expect(summarizeMissionFailure("   \n  ").reason).toBe("no failure detail reported");
  });
});

describe("missionFailureLine", () => {
  test("renders verdict + clean reason, single line, no raw chars", () => {
    const line = missionFailureLine(RAW_PLAYWRIGHT);
    expect(line).toBe("Mission failed — browser binary not installed");
    expect(line).not.toContain("\n");
    expect(line).not.toMatch(/[─-▟]/);
    expect(line).not.toContain("|");
  });

  test("accepts a custom verdict label (e.g. PARTIAL)", () => {
    expect(missionFailureLine("Timeout 30000ms exceeded", "Mission incomplete")).toBe(
      "Mission incomplete — timed out",
    );
  });
});

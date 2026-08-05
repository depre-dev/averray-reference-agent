// The glosses exist to be read by someone who did NOT build the board, so the
// tests hold them to a reader's standard, not a compiler's.
import { describe, expect, test } from "vitest";

import { OPS_GLOSS } from "./ops-gloss.js";

describe("every gloss is a real explanation", () => {
  test("full sentences, not labels — a gloss shorter than the jargon is decoration", () => {
    for (const [key, text] of Object.entries(OPS_GLOSS)) {
      expect(text.length, `${key} is too short to explain anything`).toBeGreaterThan(60);
      expect(text.endsWith("."), `${key} must end as a sentence`).toBe(true);
    }
  });

  test("no gloss leans on another board term it does not explain", () => {
    // "See RUNWAY" would send the reader on the hunt this file exists to end.
    for (const [key, text] of Object.entries(OPS_GLOSS)) {
      expect(text, `${key} must not cross-reference`).not.toMatch(/\bsee\s+[A-Z]/);
    }
  });

  test("definitions carry no live numbers — those belong to the view models", () => {
    // A number in a definition is a written fact that goes stale silently —
    // the exact failure class the credential probe was built against. The one
    // sanctioned exception is naming a window or a ratio bound (24h, ×1.0).
    for (const [key, text] of Object.entries(OPS_GLOSS)) {
      const numbers = (text.match(/\d+(\.\d+)?/g) ?? []).filter((n) => !["24", "1.0"].includes(n));
      expect(numbers, `${key} carries live-looking numbers: ${numbers.join(", ")}`).toEqual([]);
    }
  });
});

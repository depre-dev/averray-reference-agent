import { test, assert } from "vitest";

import { parseHermesInput } from "./hermes-commands.js";

test("parseHermesInput: /mission with a valid https URL → mission", () => {
  assert.deepEqual(parseHermesInput("/mission https://staging.averray.com/onboarding"), {
    kind: "mission",
    url: "https://staging.averray.com/onboarding",
  });
});

test("parseHermesInput: http and localhost URLs are accepted", () => {
  assert.deepEqual(parseHermesInput("/mission http://localhost:5173/claim"), {
    kind: "mission",
    url: "http://localhost:5173/claim",
  });
});

test("parseHermesInput: case-insensitive command + surrounding whitespace", () => {
  assert.deepEqual(parseHermesInput("   /MISSION   https://x.test/y  "), {
    kind: "mission",
    url: "https://x.test/y",
  });
});

test("parseHermesInput: only the first token is taken as the URL", () => {
  assert.deepEqual(parseHermesInput("/mission https://x.test/y and then check the footer"), {
    kind: "mission",
    url: "https://x.test/y",
  });
});

test("parseHermesInput: /mission with no URL → error", () => {
  const out = parseHermesInput("/mission");
  assert.equal(out.kind, "error");
});

test("parseHermesInput: /mission with a non-URL arg → error", () => {
  const out = parseHermesInput("/mission staging.averray.com");
  assert.equal(out.kind, "error");
});

test("parseHermesInput: plain text → ask", () => {
  assert.deepEqual(parseHermesInput("what's blocking #548?"), {
    kind: "ask",
    text: "what's blocking #548?",
  });
});

test("parseHermesInput: empty / whitespace → empty", () => {
  assert.equal(parseHermesInput("").kind, "empty");
  assert.equal(parseHermesInput("   ").kind, "empty");
  assert.equal(parseHermesInput(undefined as unknown as string).kind, "empty");
});

test("parseHermesInput: a word starting with mission but not the command is an ask", () => {
  assert.equal(parseHermesInput("missionary work").kind, "ask");
});

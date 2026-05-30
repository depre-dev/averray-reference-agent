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

test("parseHermesInput: /claude <repo> <task> → claude (repo + full prompt)", () => {
  assert.deepEqual(parseHermesInput("/claude averray-agent/agent Add a HEALTHCHECK.md at the repo root"), {
    kind: "claude",
    repo: "averray-agent/agent",
    prompt: "Add a HEALTHCHECK.md at the repo root",
  });
});

test("parseHermesInput: /claude is case-insensitive and trims surrounding whitespace", () => {
  assert.deepEqual(parseHermesInput("  /CLAUDE   owner/repo   do the thing  "), {
    kind: "claude",
    repo: "owner/repo",
    prompt: "do the thing",
  });
});

test("parseHermesInput: /claude with no args → error", () => {
  assert.equal(parseHermesInput("/claude").kind, "error");
});

test("parseHermesInput: /claude with a repo but no task → error", () => {
  assert.equal(parseHermesInput("/claude averray-agent/agent").kind, "error");
});

test("parseHermesInput: /claude with a malformed repo → error", () => {
  assert.equal(parseHermesInput("/claude not-a-repo do something").kind, "error");
});

test("parseHermesInput: a word starting with claude but not the command is an ask", () => {
  assert.equal(parseHermesInput("claudette asked about #548").kind, "ask");
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

test("parseHermesInput: /mute with a duration → mute with a future expiry", () => {
  const now = () => 1_000;
  const out = parseHermesInput("/mute 1h", now);
  assert.equal(out.kind, "mute");
  if (out.kind === "mute") assert.equal(out.untilMs, 1_000 + 3_600_000);
});

test("parseHermesInput: bare /mute defaults to one hour", () => {
  const out = parseHermesInput("/mute", () => 0);
  assert.equal(out.kind, "mute");
  if (out.kind === "mute") assert.equal(out.untilMs, 3_600_000);
});

test("parseHermesInput: /unmute → unmute", () => {
  assert.equal(parseHermesInput("/unmute").kind, "unmute");
});

test("parseHermesInput: an unparseable /mute argument → error", () => {
  assert.equal(parseHermesInput("/mute whenever").kind, "error");
});

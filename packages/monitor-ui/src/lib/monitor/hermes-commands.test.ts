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

// ── /task <agent> [<repo>#<pr>] <prompt> (O3) ──────────────────────
test("parseHermesInput: /task claude <repo> <prompt> → greenfield claude task (no PR)", () => {
  assert.deepEqual(parseHermesInput("/task claude averray-agent/agent Add a HEALTHCHECK.md at the root"), {
    kind: "task",
    agent: "claude",
    repo: "averray-agent/agent",
    prompt: "Add a HEALTHCHECK.md at the root",
  });
});

test("parseHermesInput: /task test-writer <repo> <prompt> → specialist greenfield task", () => {
  assert.deepEqual(parseHermesInput("/task test-writer averray-agent/agent Add parser coverage"), {
    kind: "task",
    agent: "test-writer",
    repo: "averray-agent/agent",
    prompt: "Add parser coverage",
  });
});

test("parseHermesInput: /task codex <repo>#<pr> <prompt> → codex task with PR", () => {
  assert.deepEqual(parseHermesInput("/task codex averray-agent/agent#123 tighten the validator"), {
    kind: "task",
    agent: "codex",
    repo: "averray-agent/agent",
    pullRequestNumber: 123,
    prompt: "tighten the validator",
  });
});

test("parseHermesInput: /task is case-insensitive and trims", () => {
  const out = parseHermesInput("  /TASK   claude   owner/repo   do the thing  ");
  assert.deepEqual(out, { kind: "task", agent: "claude", repo: "owner/repo", prompt: "do the thing" });
});

test("parseHermesInput: /task with an unknown agent → error", () => {
  assert.equal(parseHermesInput("/task gpt5 owner/repo do x").kind, "error");
});

test("parseHermesInput: /task codex without a PR → error (codex iterates an existing PR)", () => {
  assert.equal(parseHermesInput("/task codex owner/repo do x").kind, "error");
});

test("parseHermesInput: /task with a malformed repo → error", () => {
  assert.equal(parseHermesInput("/task claude not-a-repo do x").kind, "error");
});

test("parseHermesInput: /task with no prompt → error", () => {
  assert.equal(parseHermesInput("/task claude owner/repo").kind, "error");
});

test("parseHermesInput: bare /task → error", () => {
  assert.equal(parseHermesInput("/task").kind, "error");
});

test("parseHermesInput: a word starting with task but not the command is an ask", () => {
  assert.equal(parseHermesInput("tasks for today?").kind, "ask");
});

// ── O4-PR3a autonomy-mode NL parsing ────────────────────────────────

const NOW = new Date("2026-05-31T09:00:00.000Z").getTime();
const at = () => NOW;
const HOUR = 3_600_000;

test("autonomy: open-ended 'you're in charge' → autopilot capped at now+4h", () => {
  assert.deepEqual(parseHermesInput("Hermes, you're in charge", at), {
    kind: "autopilot",
    untilMs: NOW + 4 * HOUR,
  });
});

test("autonomy: 'take over for 2h' → autopilot at now+2h", () => {
  assert.deepEqual(parseHermesInput("take over for 2h", at), {
    kind: "autopilot",
    untilMs: NOW + 2 * HOUR,
  });
});

test("autonomy: 'for 90 minutes' duration honored", () => {
  assert.deepEqual(parseHermesInput("you're in charge for 90 minutes", at), {
    kind: "autopilot",
    untilMs: NOW + 90 * 60_000,
  });
});

test("autonomy: a stated duration beyond 4h is honored (not re-capped)", () => {
  assert.deepEqual(parseHermesInput("you're in charge for 8h", at), {
    kind: "autopilot",
    untilMs: NOW + 8 * HOUR,
  });
});

test("autonomy: 'until 5pm' → autopilot with a future clock time", () => {
  const cmd = parseHermesInput("you're in charge until 5pm", at);
  assert.equal(cmd.kind, "autopilot");
  if (cmd.kind === "autopilot") {
    assert.ok(cmd.untilMs > NOW, "until is in the future");
    const d = new Date(cmd.untilMs);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getHours(), 17); // 5pm local
  }
});

test("autonomy: 'I'm back' → supervised", () => {
  assert.deepEqual(parseHermesInput("I'm back", at), { kind: "supervised" });
});

test("autonomy: 'stand down' / 'autopilot off' → supervised", () => {
  assert.deepEqual(parseHermesInput("stand down", at), { kind: "supervised" });
  assert.deepEqual(parseHermesInput("autopilot off", at), { kind: "supervised" });
});

test("autonomy: slash forms /autopilot and /supervised", () => {
  assert.equal(parseHermesInput("/autopilot until 3pm", at).kind, "autopilot");
  assert.deepEqual(parseHermesInput("/supervised", at), { kind: "supervised" });
});

test("autonomy: 'take back' reverts (does not match the autopilot 'take' trigger)", () => {
  assert.deepEqual(parseHermesInput("ok I'll take back control", at), { kind: "supervised" });
});

test("autonomy: an unrelated sentence is still an ask, not a mode change", () => {
  assert.equal(parseHermesInput("what is the charge for this task?", at).kind, "ask");
  // "are you in charge…" doesn't match a delegation trigger → no false positive.
  assert.equal(parseHermesInput("are you in charge of the indexer?", at).kind, "ask");
});

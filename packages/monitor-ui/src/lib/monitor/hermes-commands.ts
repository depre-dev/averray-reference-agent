// Hermes Handoff Monitor — co-pilot composer command parsing (M7'/M9').
//
// The Hermes composer is a single text input that doubles as a command
// line:
//   /mission <url>                        spawn a browser mission (M7')
//   /task <agent> [<repo>#<pr>] <prompt>  propose a codex|claude|specialist task (O3/C3)
//   /claude <repo> <…>                    propose a greenfield Claude task (O2 shortcut)
//   /mute [1h|9am|…]                      silence action alerts; /unmute clears it
//   anything else                         a question routed to Hermes
// Parsing lives here as a pure function so the composer stays dumb and
// the contract is tested.

import { parseMuteArg } from "./notifications.js";

export type TaskAgent = "codex" | "claude" | "test-writer" | "security" | "docs";

export type HermesCommand =
  | { kind: "mission"; url: string }
  | { kind: "claude"; repo: string; prompt: string }
  | { kind: "task"; agent: TaskAgent; repo: string; pullRequestNumber?: number; prompt: string }
  | { kind: "mute"; untilMs: number }
  | { kind: "unmute" }
  // O4-PR3a — autonomy mode. "autopilot" delegates approval to Hermes until
  // `untilMs` (a stated time, else the now+4h safety cap); "supervised" reverts.
  | { kind: "autopilot"; untilMs: number }
  | { kind: "supervised" }
  | { kind: "ask"; text: string }
  | { kind: "error"; message: string }
  | { kind: "empty" };

/** A forgotten autopilot can't run forever: the open-ended end-of-autopilot cap. */
export const AUTOPILOT_SAFETY_CAP_MS = 4 * 60 * 60 * 1000;

const MISSION_RE = /^\/mission\b\s*(.*)$/is;
const TASK_RE = /^\/task\b\s*(.*)$/is;
const CLAUDE_RE = /^\/claude\b\s*(.*)$/is;
const MUTE_RE = /^\/mute\b\s*(.*)$/is;
const UNMUTE_RE = /^\/unmute\b/i;
const URL_RE = /^https?:\/\/\S+$/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// owner/repo  or  owner/repo#123
const TASK_TARGET_RE = /^([\w.-]+\/[\w.-]+)(?:#(\d+))?$/;

export function parseHermesInput(raw: string, now: () => number = Date.now): HermesCommand {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "empty" };

  const mission = MISSION_RE.exec(text);
  if (mission) {
    const arg = (mission[1] ?? "").trim();
    if (!arg) {
      return { kind: "error", message: "/mission needs a target URL, e.g. /mission https://staging.averray.com/onboarding" };
    }
    const url = arg.split(/\s+/)[0] ?? "";
    if (!URL_RE.test(url)) {
      return { kind: "error", message: `"${url}" is not a valid http(s) URL.` };
    }
    return { kind: "mission", url };
  }

  const task = TASK_RE.exec(text);
  if (task) {
    const arg = (task[1] ?? "").trim();
    if (!arg) {
      return { kind: "error", message: "/task needs an agent, repo, and a prompt, e.g. /task test-writer averray-agent/agent Add parser tests" };
    }
    const agentGap = arg.search(/\s/);
    const agentRaw = (agentGap === -1 ? arg : arg.slice(0, agentGap)).toLowerCase();
    if (!isTaskAgent(agentRaw)) {
      return { kind: "error", message: `"${agentRaw}" is not a valid agent (expected codex, claude, test-writer, security, or docs).` };
    }
    const rest = (agentGap === -1 ? "" : arg.slice(agentGap + 1)).trim();
    const targetGap = rest.search(/\s/);
    const target = (targetGap === -1 ? rest : rest.slice(0, targetGap)).trim();
    const prompt = (targetGap === -1 ? "" : rest.slice(targetGap + 1)).trim();
    const matched = TASK_TARGET_RE.exec(target);
    if (!matched) {
      return { kind: "error", message: `"${target || "(none)"}" is not a valid owner/repo or owner/repo#pr.` };
    }
    const repo = matched[1] ?? "";
    const pullRequestNumber = matched[2] ? Number(matched[2]) : undefined;
    if (!prompt) {
      return { kind: "error", message: "/task needs a prompt after the repo." };
    }
    if (agentRaw === "codex" && pullRequestNumber === undefined) {
      return { kind: "error", message: "/task codex needs an existing PR, e.g. /task codex averray-agent/agent#123 <prompt>." };
    }
    return {
      kind: "task",
      agent: agentRaw,
      repo,
      ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
      prompt,
    };
  }

  const claude = CLAUDE_RE.exec(text);
  if (claude) {
    const arg = (claude[1] ?? "").trim();
    if (!arg) {
      return { kind: "error", message: "/claude needs a repo and a task, e.g. /claude averray-agent/agent Add a HEALTHCHECK.md" };
    }
    const gap = arg.search(/\s/);
    const repo = (gap === -1 ? arg : arg.slice(0, gap)).trim();
    const prompt = (gap === -1 ? "" : arg.slice(gap + 1)).trim();
    if (!REPO_RE.test(repo)) {
      return { kind: "error", message: `"${repo}" is not a valid owner/repo (e.g. averray-agent/agent).` };
    }
    if (!prompt) {
      return { kind: "error", message: "/claude needs a task description after the repo." };
    }
    return { kind: "claude", repo, prompt };
  }

  if (UNMUTE_RE.test(text)) return { kind: "unmute" };

  const mute = MUTE_RE.exec(text);
  if (mute) {
    const parsed = parseMuteArg(mute[1] ?? "", now);
    return parsed.ok ? { kind: "mute", untilMs: parsed.untilMs } : { kind: "error", message: parsed.error };
  }

  const autonomy = parseAutonomyDirective(text, now);
  if (autonomy) return autonomy;

  return { kind: "ask", text };
}

function isTaskAgent(value: string): value is TaskAgent {
  return value === "codex" || value === "claude" || value === "test-writer" || value === "security" || value === "docs";
}

// ── O4-PR3a autonomy-mode NL parsing ────────────────────────────────
//
// "Hermes, you're in charge until 5pm" / "for 2h" / open-ended → autopilot
// (open-ended gets the now+4h safety cap). "I'm back" / "stand down" /
// "autopilot off" → supervised. Slash forms /autopilot and /supervised too.

// Revert-to-supervised triggers (checked first — "take back" must not match the
// "take ..." autopilot trigger).
const SUPERVISED_RE = /(^\/supervised\b|\bi'?m back\b|\bi am back\b|\bstand down\b|\bautopilot\s+off\b|\btake\s+back\b|\bi'?ve got it\b|\byou'?re off\b)/i;
// Engage-autopilot triggers.
const AUTOPILOT_RE = /(^\/autopilot\b|\byou'?re in charge\b|\byou are in charge\b|\byou'?ve got (?:it|the wheel|this)\b|\btake (?:over|the wheel|the lead)\b|\bautopilot\s+on\b)/i;
// Window extraction within the directive.
const FOR_DUR_RE = /\bfor\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i;
const UNTIL_CLOCK_RE = /\buntil\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

function parseAutonomyDirective(text: string, now: () => number): HermesCommand | null {
  if (SUPERVISED_RE.test(text)) return { kind: "supervised" };
  if (!AUTOPILOT_RE.test(text)) return null;
  return { kind: "autopilot", untilMs: parseAutonomyWindow(text, now) };
}

/** Stated time honored; absent/unparseable → the now+4h safety cap. */
function parseAutonomyWindow(text: string, now: () => number): number {
  const nowMs = now();
  const dur = FOR_DUR_RE.exec(text);
  if (dur) {
    const n = Number.parseInt(dur[1] as string, 10);
    if (n > 0) {
      const ms = (dur[2] as string).toLowerCase().startsWith("m") ? n * 60_000 : n * 3_600_000;
      return nowMs + ms;
    }
  }
  const clock = UNTIL_CLOCK_RE.exec(text);
  if (clock) {
    let hour = Number.parseInt(clock[1] as string, 10);
    const min = clock[2] ? Number.parseInt(clock[2], 10) : 0;
    const ap = clock[3]?.toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (hour <= 23 && min <= 59) {
      const d = new Date(nowMs);
      d.setHours(hour, min, 0, 0);
      let untilMs = d.getTime();
      if (untilMs <= nowMs) untilMs += 24 * 60 * 60 * 1000;
      return untilMs;
    }
  }
  return nowMs + AUTOPILOT_SAFETY_CAP_MS;
}

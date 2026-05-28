// Hermes Handoff Monitor — co-pilot composer command parsing (M7'/M9').
//
// The Hermes composer is a single text input that doubles as a command
// line:
//   /mission <url>      spawn a browser mission against a live URL
//   /mute [1h|9am|…]    silence action alerts (M9'); /unmute clears it
//   anything else       a question routed to Hermes
// Parsing lives here as a pure function so the composer stays dumb and
// the contract is tested.

import { parseMuteArg } from "./notifications.js";

export type HermesCommand =
  | { kind: "mission"; url: string }
  | { kind: "mute"; untilMs: number }
  | { kind: "unmute" }
  | { kind: "ask"; text: string }
  | { kind: "error"; message: string }
  | { kind: "empty" };

const MISSION_RE = /^\/mission\b\s*(.*)$/is;
const MUTE_RE = /^\/mute\b\s*(.*)$/is;
const UNMUTE_RE = /^\/unmute\b/i;
const URL_RE = /^https?:\/\/\S+$/i;

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

  if (UNMUTE_RE.test(text)) return { kind: "unmute" };

  const mute = MUTE_RE.exec(text);
  if (mute) {
    const parsed = parseMuteArg(mute[1] ?? "", now);
    return parsed.ok ? { kind: "mute", untilMs: parsed.untilMs } : { kind: "error", message: parsed.error };
  }

  return { kind: "ask", text };
}

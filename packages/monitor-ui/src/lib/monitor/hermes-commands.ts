// Hermes Handoff Monitor — co-pilot composer command parsing (M7').
//
// The Hermes composer is a single text input that doubles as a command
// line. `/mission <url>` spawns a browser mission against a live URL;
// anything else is a question routed to Hermes. Parsing lives here as a
// pure function so the composer stays dumb and the contract is tested.

export type HermesCommand =
  | { kind: "mission"; url: string }
  | { kind: "ask"; text: string }
  | { kind: "error"; message: string }
  | { kind: "empty" };

const MISSION_RE = /^\/mission\b\s*(.*)$/is;
const URL_RE = /^https?:\/\/\S+$/i;

export function parseHermesInput(raw: string): HermesCommand {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "empty" };

  const m = MISSION_RE.exec(text);
  if (m) {
    const arg = (m[1] ?? "").trim();
    if (!arg) {
      return { kind: "error", message: "/mission needs a target URL, e.g. /mission https://staging.averray.com/onboarding" };
    }
    const url = arg.split(/\s+/)[0] ?? "";
    if (!URL_RE.test(url)) {
      return { kind: "error", message: `"${url}" is not a valid http(s) URL.` };
    }
    return { kind: "mission", url };
  }

  return { kind: "ask", text };
}

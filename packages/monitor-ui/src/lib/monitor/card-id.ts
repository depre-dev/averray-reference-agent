// Shared card-id → header-badge formatting.
//
// Both the full <Card> (decision inbox / lanes) and the read-only
// <PipelineMirrorCard> (WATCH/HIDE mirror lanes) render the same monospace id
// badge next to the agent name, so the formatting MUST live in one place — a
// duplicated copy already drifted once (the mirror lane kept showing the raw
// machine task id after the Card copy was shortened).

/**
 * Turn a card ID into the compact monospace badge shown next to the agent name.
 * First strips the leading agent-type prefix (`agent #548` → `#548`,
 * `mission browser-X` → `browser-X`). Then, for routed codex/claude task ids —
 * long machine handles like `codex-task-averray-agent-agent-new-…Z-vfs58z` that
 * carry no operator meaning and crush the agent label to a `c…` stub — collapse
 * to a short stable handle (`task vfs58z`). PR refs (`#711`) and short slugs
 * (`browser-onboard-04`, `starter-coding-014`) are left untouched.
 */
export function shortId(id: string): string {
  const withoutAgent = id.replace(/^[a-z-]+ /, "");
  if (/(?:^|-)task-/.test(withoutAgent) && !withoutAgent.includes("#")) {
    const tail = withoutAgent.match(/[a-z0-9]{4,12}$/i)?.[0];
    if (tail) return `task ${tail}`;
  }
  return withoutAgent;
}

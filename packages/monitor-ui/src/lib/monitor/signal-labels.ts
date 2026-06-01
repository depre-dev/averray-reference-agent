export interface HumanizedSignalPart {
  text: string;
  rawCode?: string;
}

const SIGNAL_LABELS: Record<string, string> = {
  dispatch_budget_exhausted: "Dispatch budget used up - paused until reset",
  open_fix_cap_reached: "Self-healing fix cap reached - won't propose more",
  duplicate_signal: "Skipped - duplicate of an existing fix",
  routed_fix: "Routed fix proposal",
  not_auto_fixable: "Needs human diagnosis - not a code-agent fix",
};

const ENUM_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

export function humanizeSignalCode(code: string): string {
  return SIGNAL_LABELS[code] ?? code.replace(/_/g, " ");
}

export function humanizeSignalText(value: string | undefined): string {
  return humanizedSignalParts(value).map((part) => part.text).join("");
}

export function humanizedSignalParts(value: string | undefined): HumanizedSignalPart[] {
  if (!value) return [];
  const parts: HumanizedSignalPart[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(ENUM_TOKEN)) {
    const rawCode = match[0] ?? "";
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ text: value.slice(lastIndex, index) });
    parts.push({ text: humanizeSignalCode(rawCode), rawCode });
    lastIndex = index + rawCode.length;
  }
  if (lastIndex < value.length) parts.push({ text: value.slice(lastIndex) });
  return parts;
}

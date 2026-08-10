// The morning digest — one message at a chosen local time, then silence.
//
// The #Ops channel had taught the operator to ignore it: eight flapping
// capability alerts in a day, speaking in enum values. The alert hold fixed the
// noise; this is the other half. A channel that only ever speaks when something
// crosses a threshold leaves the operator to PULL the daily picture from the
// board. One scheduled message carries it to them: verdict, flow, floors,
// credentials, the bank lane, and anything currently not-ok — then the channel
// goes quiet again until something real happens.
//
// ── WHY THIS LIVES HERE AND NOT IN HERMES CRON ────────────────────────────
//
// Decided when Buzz went live: Hermes cron's `--deliver` has no Buzz target,
// and Hermes v0.20.0's bundled Buzz platform was deliberately declined (second
// inbound path, weaker gates). slack-operator already owns the only sanctioned
// Buzz publisher, so the schedule lives beside it.
//
// ── ONE VERDICT SYSTEM ────────────────────────────────────────────────────
//
// The digest quotes the SAME strings the board renders — probe details decided
// server-side, the shared deriveOpsVerdict headline — and composes zero
// judgments of its own. Two verdict systems disagree eventually, and the first
// disagreement is the last time the operator believes either.
//
// This file writes the digest in sentences rather than caps-keyed telegraph
// (operator feedback 2026-08-05, reading it on the phone: "more human … not
// just some boring stats") — but "human" here is FRAMING. The opening counts
// statuses the producers decided; the closing line maps mechanically from
// (red, degraded, bank tone); every detail is quoted verbatim. The genuinely
// conversational rendering — Hermes writing the same facts in his own words —
// lives in digest-voice.ts behind a gate that falls back to this text, which
// makes this the digest's floor: always present, never wrong.
//
// ── TIME IS LOCAL, AND FAIL-CLOSED ────────────────────────────────────────
//
// "08:00" means the operator's morning, not the server's UTC. The timezone is
// config; an invalid one DISABLES the digest with a named problem rather than
// guessing — a digest at a wrong-guessed hour is the wrong-subject failure
// wearing a clock. Late is honest: if the process was down at 08:00, the
// digest fires on the first tick after it comes back, stamped with the time it
// actually ran — and greetingFor() reads that stamp, so a 14:37 catch-up does
// not open with "Good morning".
//
// Kept pure — no clock, no I/O — so every rule is testable without a relay.

import { isUnknownReadingProbe } from "@avg/schemas";

import { greetingFor, probeLabel, statusGlyph } from "./ops-voice.js";

export interface DigestSchedule {
  enabled: boolean;
  /** Local wall-clock target. */
  hour: number;
  minute: number;
  /** IANA zone the wall clock is read in. */
  timeZone: string;
  /** Why the digest is disabled despite the env asking for it. */
  problem?: string;
}

/**
 * Parse the schedule from env. Disabled by default — a scheduled message is
 * armed deliberately, like every other feature flag here.
 */
export function readDigestSchedule(env: NodeJS.ProcessEnv = process.env): DigestSchedule {
  const off: DigestSchedule = { enabled: false, hour: 8, minute: 0, timeZone: "Europe/Zurich" };
  const flag = (env.BUZZ_MORNING_DIGEST ?? "").trim();
  if (!["1", "true", "yes", "on"].includes(flag.toLowerCase())) return off;

  const time = (env.BUZZ_DIGEST_TIME ?? "08:00").trim();
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) {
    return { ...off, problem: `BUZZ_DIGEST_TIME "${time}" is not HH:MM — digest disabled rather than guessed` };
  }

  const timeZone = (env.BUZZ_DIGEST_TZ ?? "Europe/Zurich").trim();
  try {
    // The only reliable IANA-zone validator Node ships. Throws on garbage.
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    return { ...off, problem: `BUZZ_DIGEST_TZ "${timeZone}" is not an IANA zone — digest disabled rather than guessed` };
  }

  return { enabled: true, hour: Number(m[1]), minute: Number(m[2]), timeZone };
}

/**
 * The local calendar date and minutes-since-midnight at `nowMs` in `timeZone`,
 * plus the human forms of the same instant ("Wednesday", "6 Aug"). `date`
 * stays strictly YYYY-MM-DD — it is the once-per-day dedupe identity and must
 * never absorb formatting concerns.
 */
export function localStamp(
  nowMs: number,
  timeZone: string,
): { date: string; minutes: number; hhmm: string; weekday: string; humanDate: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  // Intl emits "24" for midnight in some ICU versions; normalise.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const human = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "short" });
  const humanParts = Object.fromEntries(human.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday: humanParts.weekday ?? "",
    humanDate: humanParts.day && humanParts.month ? `${humanParts.day} ${humanParts.month}` : "",
  };
}

/**
 * Once per local day, at or after the target time.
 *
 * Down at 08:00 → fires when the process returns (late beats absent, and the
 * message is stamped with its real time). Already sent today → never again,
 * whatever restarts happen — which is why the caller persists the local DATE
 * rather than a timestamp: the date is the fact "today's digest exists".
 */
export function digestDue(input: {
  nowMs: number;
  schedule: DigestSchedule;
  lastSentLocalDate: string | null;
}): { due: boolean; localDate: string; localTime: string; weekday: string; humanDate: string } {
  const { schedule } = input;
  const stamp = localStamp(input.nowMs, schedule.timeZone);
  const due =
    schedule.enabled &&
    stamp.minutes >= schedule.hour * 60 + schedule.minute &&
    input.lastSentLocalDate !== stamp.date;
  return { due, localDate: stamp.date, localTime: stamp.hhmm, weekday: stamp.weekday, humanDate: stamp.humanDate };
}

/** The probe shape the digest reads — the same one the board renders. */
export interface DigestProbe {
  name: string;
  status: string;
  /** "unknown" ⇒ the probe took no reading at all. Absent ⇒ observed. */
  reading?: string;
  detail: string;
}

export interface MorningDigestInput {
  localDate: string;
  localTime: string;
  /** Human forms of the same instant; the ISO date stands in when absent. */
  weekday?: string;
  humanDate?: string;
  timeZone: string;
  network: string;
  /** deriveOpsVerdict output — headline is prose FOR humans; that is this. */
  verdictHeadline: string;
  /**
   * The verdict CONTRACT fields beside the quotable headline. The closing
   * line must never out-calm the verdict: floor-breach, payout-shortfall and
   * pool-draining derive from pools and payout evidence, so they exist with
   * every probe green — and "Nothing is waiting on you" under such a headline
   * is exactly the contradiction the one-verdict rule forbids (found by
   * truth-boundary review of #755). `reason` decides calm; `tone` (producer
   * severity) decides urgency. Optional for old fixtures; absent means calm.
   */
  verdictReason?: string;
  verdictTone?: string;
  probes: readonly DigestProbe[];
  /** The bank lane's server-decided requests line, when a lane exists at all. */
  bankRequests?: { text: string; tone: string } | null;
  /**
   * The public-record line from social-signal.ts, when configured. Decided
   * there, composed here — like the bank line.
   *
   * Its tone is deliberately NOT counted toward "needs you now" or "worth a
   * look": a post worth writing is not an operational finding, and a social
   * reading that could not be taken says nothing about the product. Both would
   * inflate the urgency count with something the operator cannot act on at 7am,
   * which is how that count stops being believed.
   */
  socialSignal?: { text: string; tone: string } | null;
}

const DIGEST_LINE_PROBES: readonly { key: string; name: string }[] = [
  { key: "Money", name: "money_path" },
  { key: "Floors", name: "signer_liquidity" },
  { key: "Credentials", name: "credential_expiry" },
];

/**
 * The strings whose figures are load-bearing: the daily fact lines, every
 * not-ok detail, and the bank line. digest-voice.ts extracts its must-survive
 * tokens from exactly this list, so "which strings may Hermes not lose" has
 * one definition, and it lives beside the layout that renders them.
 */
export function digestFactStrings(input: MorningDigestInput): string[] {
  const byName = new Map(input.probes.map((p) => [p.name, p] as const));
  const facts: string[] = [];
  for (const { name } of DIGEST_LINE_PROBES) {
    const probe = byName.get(name);
    if (probe) facts.push(probe.detail);
  }
  for (const probe of input.probes) {
    if (probe.status !== "ok") facts.push(probe.detail);
  }
  if (input.bankRequests) facts.push(input.bankRequests.text);
  // Included for the same reason as the bank line, and one of its own: the
  // degraded form ("could not read the public record") must survive a
  // rephrasing, or the digest reads as complete when it was not.
  if (input.socialSignal) facts.push(input.socialSignal.text);
  return facts;
}

/**
 * Compose the message. Every content string is a probe's own detail or the
 * shared verdict headline — this function chooses layout and framing words,
 * nothing else.
 *
 *  · The first line is the lock screen: greeting + the status count, so the
 *    notification preview alone says whether to reach for the phone.
 *  · A probe that is absent contributes NO line. Absence is not zero, and a
 *    "Money: —" placeholder would claim a measurement nobody took.
 *  · Probes that are not ok get quoted in full under "Needs attention" (red
 *    first), because the alert hold may have (correctly) never announced a
 *    flapping one — the digest is the once-a-day complete picture.
 *  · The bank line appears only when a lane exists — the same absent-is-
 *    nothing rule the board and the phone follow.
 *  · The closing line maps mechanically from (red, degraded, bank tone): who
 *    is waiting on the operator, said plainly. Bank tone "awaiting" is an
 *    instrument that cannot see, not a problem — it never summons anyone.
 */
export function buildMorningDigest(input: MorningDigestInput): string {
  const byName = new Map(input.probes.map((p) => [p.name, p] as const));
  const total = input.probes.length;
  // A probe that took NO READING is not a probe needing attention — it is an
  // instrument that could not see. Counting them together turned one container
  // DNS failure into "4 of 9 probes need attention" on 2026-08-06: four
  // findings about a product nobody had managed to ask.
  //
  // They are still named, on their own line, because an unreadable instrument
  // is exactly the thing the operator must know about before trusting the rest
  // of the digest. Excluded from the count, never from the message.
  const unreadable = input.probes.filter(isUnknownReadingProbe);
  const attention = input.probes.filter((p) => p.status !== "ok" && !isUnknownReadingProbe(p));
  const reds = attention.filter((p) => p.status === "red").length;

  const greeting = greetingFor(input.localTime);
  const where = `Averray ${input.network}`;
  const opener =
    total === 0
      ? `${greeting} — no probes reporting on ${where}.`
      : attention.length === 0
        ? unreadable.length > 0
          ? `${greeting} — ${total - unreadable.length} of ${total} probes green on ${where}; ${unreadable.length} could not be read.`
          : `${greeting} — all ${total} probes green on ${where}.`
        : `${greeting} — ${attention.length} of ${total} probe${total === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention on ${where}.`;

  const stamp =
    input.weekday && input.humanDate
      ? `${input.weekday} ${input.humanDate}, ${input.localTime} (${input.timeZone})`
      : `${input.localDate} ${input.localTime} (${input.timeZone})`;

  const lines: string[] = [opener];
  lines.push(`${stamp}. The board reads: "${input.verdictHeadline}"`);
  lines.push("");

  for (const { key, name } of DIGEST_LINE_PROBES) {
    const probe = byName.get(name);
    if (probe) lines.push(`${key}: ${probe.detail}`);
  }
  if (input.bankRequests) lines.push(`Bank: ${input.bankRequests.text}`);
  if (input.socialSignal) lines.push(`Public record: ${input.socialSignal.text}`);

  if (attention.length > 0) {
    const redFirst = [...attention].sort(
      (a, b) => (a.status === "red" ? 0 : 1) - (b.status === "red" ? 0 : 1),
    );
    lines.push("");
    lines.push("Needs attention:");
    for (const probe of redFirst) {
      lines.push(`${statusGlyph(probe.status)} ${probeLabel(probe.name)} — ${probe.detail}`);
    }
  }

  // Its own heading, deliberately not "Needs attention". Nothing here is a
  // finding about the product; the finding is that we could not look.
  if (unreadable.length > 0) {
    lines.push("");
    lines.push("Could not be read (no evidence either way):");
    for (const probe of unreadable) {
      lines.push(`· ${probeLabel(probe.name)} — ${probe.detail}`);
    }
  }

  const bankTone = input.bankRequests?.tone;
  const needsNow = reds + (bankTone === "red" ? 1 : 0);
  const worthALook = attention.length - reds + (bankTone === "degraded" ? 1 : 0);
  const verdictCalm = input.verdictReason === undefined || input.verdictReason === "nominal";
  const verdictUrgent = input.verdictTone === "red";
  lines.push("");
  if (verdictUrgent && needsNow === 0) {
    // A red verdict with green probes (floor breach, payout shortfall) —
    // the probes cannot summon the operator, so the verdict must.
    lines.push("The verdict line above needs you now.");
  } else if (needsNow > 0) {
    lines.push(needsNow === 1 ? "One item needs you now." : `${needsNow} items need you now.`);
  } else if (worthALook > 0) {
    lines.push(
      verdictCalm
        ? "Worth a look when you're at the desk — nothing is on fire."
        : "Worth a look when you're at the desk — and read the verdict line above.",
    );
  } else if (verdictCalm) {
    lines.push("Nothing is waiting on you.");
  } else {
    lines.push("The probes are green, but the verdict line above is the one to read.");
  }

  return lines.join("\n");
}

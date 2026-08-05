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
// opinions of its own. Two verdict systems disagree eventually, and the first
// disagreement is the last time the operator believes either.
//
// ── TIME IS LOCAL, AND FAIL-CLOSED ────────────────────────────────────────
//
// "08:00" means the operator's morning, not the server's UTC. The timezone is
// config; an invalid one DISABLES the digest with a named problem rather than
// guessing — a digest at a wrong-guessed hour is the wrong-subject failure
// wearing a clock. Late is honest: if the process was down at 08:00, the
// digest fires on the first tick after it comes back, stamped with the time it
// actually ran.
//
// Kept pure — no clock, no I/O — so every rule is testable without a relay.

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

/** The local calendar date and minutes-since-midnight at `nowMs` in `timeZone`. */
export function localStamp(nowMs: number, timeZone: string): { date: string; minutes: number; hhmm: string } {
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
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
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
}): { due: boolean; localDate: string; localTime: string } {
  const { schedule } = input;
  const stamp = localStamp(input.nowMs, schedule.timeZone);
  const due =
    schedule.enabled &&
    stamp.minutes >= schedule.hour * 60 + schedule.minute &&
    input.lastSentLocalDate !== stamp.date;
  return { due, localDate: stamp.date, localTime: stamp.hhmm };
}

/** The probe shape the digest reads — the same one the board renders. */
export interface DigestProbe {
  name: string;
  status: string;
  detail: string;
}

export interface MorningDigestInput {
  localDate: string;
  localTime: string;
  timeZone: string;
  network: string;
  /** deriveOpsVerdict output — headline is prose FOR humans; that is this. */
  verdictHeadline: string;
  probes: readonly DigestProbe[];
  /** The bank lane's server-decided requests line, when a lane exists at all. */
  bankRequests?: { text: string; tone: string } | null;
}

const DIGEST_LINE_PROBES: readonly { key: string; name: string }[] = [
  { key: "FLOW", name: "money_path" },
  { key: "FLOORS", name: "signer_liquidity" },
  { key: "CREDS", name: "credential_expiry" },
];

/**
 * Compose the message. Every content string is a probe's own detail or the
 * shared verdict headline — this function chooses layout and nothing else.
 *
 *  · A probe that is absent contributes NO line. Absence is not zero, and a
 *    "FLOW —" placeholder would claim a measurement nobody took.
 *  · Probes that are not ok get quoted in full under ATTENTION, because the
 *    alert hold may have (correctly) never announced a flapping one — the
 *    digest is the once-a-day complete picture.
 *  · The bank line appears only when a lane exists — the same absent-is-
 *    nothing rule the board and the phone follow.
 */
export function buildMorningDigest(input: MorningDigestInput): string {
  const byName = new Map(input.probes.map((p) => [p.name, p] as const));
  const ok = input.probes.filter((p) => p.status === "ok").length;
  const red = input.probes.filter((p) => p.status === "red").length;

  const lines: string[] = [];
  lines.push(`MORNING DIGEST · ${input.localDate} ${input.localTime} ${input.timeZone} · AVERRAY ${input.network.toUpperCase()}`);
  lines.push(input.verdictHeadline);
  lines.push(`PROBES ${ok} ok / ${red} red of ${input.probes.length}`);

  for (const { key, name } of DIGEST_LINE_PROBES) {
    const probe = byName.get(name);
    if (probe) lines.push(`${key} ${probe.detail}`);
  }

  if (input.bankRequests) lines.push(`BANK ${input.bankRequests.text}`);

  const attention = input.probes.filter((p) => p.status !== "ok");
  if (attention.length > 0) {
    lines.push("ATTENTION");
    for (const p of attention) lines.push(`  ${p.status === "red" ? "✗" : "⚠"} ${p.name}: ${p.detail}`);
  }

  return lines.join("\n");
}

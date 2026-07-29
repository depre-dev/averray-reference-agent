// Does the monitor know what version of itself it is running?
//
// It did not, and the cost was real: on 2026-07-29 the VPS sat SIX commits
// behind main — four merged PRs were live nowhere — and nothing said so. The
// monitor tracked the PRODUCT's deploy sha all along (github-pr-state.ts) while
// being completely blind to its own. It was found only because someone SSH'd in
// for an unrelated reason.
//
// A monitor that reports on everything except itself has a hole exactly where
// its own credibility lives: every improvement it ships can sit merged and
// invisible, and it will keep saying everything is nominal.
//
// Truth boundary: "I don't know" is a real answer here and must never be
// rendered as "up to date". An unbaked sha, a rate-limited API and a genuinely
// current deploy are three different states, and only the last is good news.

/** Hours before an unshipped commit is worth naming in the detail line. */
const STALE_HOURS = 1;

export interface SelfFreshness {
  status: "current" | "behind" | "unknown";
  detail: string;
  /** The sha actually running, when it was baked into the image. */
  runningSha: string | null;
  /** Commits on main that this build does not contain; null when unknown. */
  behindBy: number | null;
  /** When the OLDEST unshipped commit landed — how long we have been stale. */
  oldestUnshippedAt: string | null;
}

export interface SelfCompare {
  behindBy: number;
  /** ISO timestamp of the oldest commit we are missing, when known. */
  oldestUnshippedAt?: string | null;
}

/**
 * Turn a running sha + a comparison against main into an operator-facing
 * verdict. PURE — `nowMs` is injected so the age phrasing is testable.
 */
export function decideSelfFreshness(input: {
  runningSha: string | null;
  /** null ⇒ the comparison could not be made (not ⇒ "no drift"). */
  compare: SelfCompare | null;
  unknownReason?: string;
  nowMs: number;
}): SelfFreshness {
  const runningSha = normalizeSha(input.runningSha);
  if (!runningSha) {
    return {
      status: "unknown",
      // The single most likely cause, named, so the fix is obvious.
      detail: "running version unknown — no build sha baked into the image (GIT_SHA build arg)",
      runningSha: null,
      behindBy: null,
      oldestUnshippedAt: null,
    };
  }
  const short = runningSha.slice(0, 8);
  if (!input.compare) {
    return {
      status: "unknown",
      detail: `${short} running · ${input.unknownReason ?? "could not compare against main"}`,
      runningSha,
      behindBy: null,
      oldestUnshippedAt: null,
    };
  }
  const behindBy = Math.max(0, Math.floor(input.compare.behindBy));
  if (behindBy === 0) {
    return {
      status: "current",
      detail: `${short} · up to date with main`,
      runningSha,
      behindBy: 0,
      oldestUnshippedAt: null,
    };
  }
  const oldest = input.compare.oldestUnshippedAt ?? null;
  const age = describeStaleFor(oldest, input.nowMs);
  return {
    status: "behind",
    detail: `${short} · ${behindBy} commit${behindBy === 1 ? "" : "s"} behind main${age ? ` · oldest merged ${age}` : ""} — merged work is not live`,
    runningSha,
    behindBy,
    oldestUnshippedAt: oldest,
  };
}

/**
 * Ask GitHub how far the running build is behind the default branch.
 *
 * One `compare` call answers it. Any failure returns null, which the decision
 * above renders as "unknown" — never as "current". A rate limit must not look
 * like a clean deploy.
 */
export async function fetchSelfCompare(input: {
  repo: string;
  runningSha: string;
  baseBranch?: string;
  token?: string;
  baseUrl?: string;
  fetchFn: typeof fetch;
}): Promise<{ compare: SelfCompare | null; reason?: string }> {
  const base = (input.baseUrl ?? "https://api.github.com").replace(/\/+$/g, "");
  const branch = input.baseBranch ?? "main";
  try {
    const response = await input.fetchFn(
      `${base}/repos/${input.repo}/compare/${encodeURIComponent(input.runningSha)}...${encodeURIComponent(branch)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        },
      },
    );
    if (!response.ok) {
      // 404 on a private repo without a token reads identically to a bad sha,
      // so say what we actually observed rather than guessing which.
      return { compare: null, reason: `GitHub compare failed (HTTP ${response.status})` };
    }
    const body = (await response.json()) as {
      behind_by?: unknown;
      commits?: { commit?: { committer?: { date?: unknown } } }[];
    };
    if (typeof body.behind_by !== "number") {
      return { compare: null, reason: "GitHub compare returned no behind_by" };
    }
    // `commits` is the list we are MISSING, oldest first.
    const oldest = Array.isArray(body.commits) ? body.commits[0]?.commit?.committer?.date : undefined;
    return {
      compare: {
        behindBy: body.behind_by,
        ...(typeof oldest === "string" ? { oldestUnshippedAt: oldest } : {}),
      },
    };
  } catch (error) {
    return {
      compare: null,
      reason: `GitHub compare failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function normalizeSha(value: string | null | undefined): string | null {
  const sha = (value ?? "").trim().toLowerCase();
  // "unknown" is the Dockerfile's honest default when no build arg was passed.
  if (!sha || sha === "unknown" || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
  return sha;
}

/** "3h", "2d" — omitted entirely when it is too fresh to be worth naming. */
function describeStaleFor(iso: string | null, nowMs: number): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const hours = (nowMs - at) / 3_600_000;
  if (hours < STALE_HOURS) return undefined;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

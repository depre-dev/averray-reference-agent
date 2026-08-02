// The board's verdict, handed to an agent as a CONCLUSION.
//
// WHY THIS EXISTS: `averray_ops_health` already describes itself to the model as
// the "canonical read-only operator health snapshot" — but it reads Postgres
// (`source: "postgres_read_only"`) and computes its own health from table stats,
// operator events and recent errors. That is control-plane health, and it is
// genuinely useful, but it is NOT what the ops board says and it is NOT what the
// operator is looking at.
//
// So an agent asked "is Averray ok?" reached for a tool named canonical, read a
// different source, and could confidently contradict the screen. Two verdict
// systems — one deterministic and tested, one that can hallucinate — will
// eventually disagree, and the first time that happens in front of the operator
// neither is trustworthy again.
//
// This tool closes that. It returns the SAME `verdict` block the board renders,
// produced by the same `deriveOpsVerdict` in @avg/schemas. The agent reads a
// conclusion instead of assembling one.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// It does not summarise, re-rank, or soften. `verdict.reason` is passed through
// untouched because it is the machine contract; `headline` and `sub` are prose
// for humans and are marked as such. Anything that reduced the payload to a
// friendlier sentence here would be a third opinion, which is the same bug in
// a smaller box.
//
// It also does not decide staleness. How old a snapshot is is a property of the
// READER, so `at` and `checkIntervalMs` are returned raw with a note, and the
// caller judges. That mirrors the board, which layers its own staleness on top
// of the shared verdict rather than baking it in.

export interface BoardHealthDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function monitorBase(env: NodeJS.ProcessEnv): string {
  return (env.AVERRAY_MONITOR_BASE_URL?.trim() || "http://slack-operator:8790").replace(/\/+$/, "");
}

function monitorAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.SLACK_OPERATOR_MONITOR_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch the board's health payload.
 *
 * A failure returns `reachable: false` with the reason rather than throwing or
 * returning an empty shell. An agent that cannot read the board must say so —
 * "everything appears operational" after a failed fetch is worse than silence,
 * and an empty object invites exactly that sentence.
 */
export async function getBoardHealth(deps: BoardHealthDeps = {}): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${monitorBase(env)}/monitor/product-health`;

  let body: Record<string, unknown>;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", ...monitorAuthHeaders(env) } });
    if (!res.ok) {
      return unreachable(url, `HTTP ${res.status}`);
    }
    body = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    return unreachable(url, error instanceof Error ? error.message : String(error));
  }

  // `enabled: false` is monitoring being OFF, which is not health — it is the
  // absence of health data. Passing it through as if it were a reading is how a
  // switched-off monitor gets reported as a quiet one.
  const enabled = body.enabled !== false;
  const verdict = body.verdict as Record<string, unknown> | undefined;

  return {
    schemaVersion: 1,
    kind: "board_health",
    mutates: false,
    reachable: true,
    source: `${url} — the same payload the ops board renders`,

    // THE ANSWER. Everything below is supporting detail for explaining it.
    verdict: verdict ?? null,
    verdictReason: verdict?.reason ?? null,

    monitoringEnabled: enabled,
    ...(enabled ? {} : { note: "monitoring is OFF — this is unknown, not healthy" }),

    at: body.at ?? null,
    checkIntervalMs: body.checkIntervalMs ?? null,
    checks: body.checks ?? null,
    staleness:
      "Judge it yourself: compare `at` against now. The verdict deliberately excludes staleness "
      + "because how old a snapshot is depends on who is reading it.",

    probes: body.probes ?? [],
    solvency: body.solvency ?? null,
    flow: body.flow ?? null,
    buzz: body.buzz ?? null,
    self: body.self ?? null,
    remediation: body.remediation ?? null,
    history: body.history ?? null,

    guidance: {
      readFirst: "verdict.reason",
      neverMatchOn: ["verdict.headline", "verdict.sub"],
      why:
        "reason is the machine contract and is stable; headline and sub are prose for a human and get "
        + "reworded. This verdict comes from the same tested deriveOpsVerdict the board renders, so "
        + "explaining it keeps you and the operator's screen in agreement.",
      notThisTool:
        "averray_ops_health answers a DIFFERENT question — database and control-plane health read from "
        + "Postgres. It is not the product verdict and the two can legitimately disagree; say which one "
        + "you are quoting.",
    },
    safety: { mutatesByDefault: false, source: "monitor_read_only" },
  };
}

function unreachable(url: string, reason: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "board_health",
    mutates: false,
    reachable: false,
    source: url,
    verdict: null,
    verdictReason: null,
    error: reason,
    guidance: {
      // The single most important sentence in this file.
      say: "The board could not be reached, so the current state is UNKNOWN. Do not infer health from "
        + "silence, and do not answer from memory of an earlier reading.",
    },
    safety: { mutatesByDefault: false, source: "monitor_read_only" },
  };
}

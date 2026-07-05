// Ops remediation suggestions — pure derivation from product health for the
// co-pilot's "Ops suggestions" box. Every incident type arrives PRE-DRAFTED: a
// specific, probe-cited remediation the operator can act on the moment it opens.
//
// Hermes SUGGESTS, never executes. Every suggestion carries a human-gated `task`
// the operator approves; a worker then runs it — Hermes never runs it himself.
// Two flavours of task:
//   - INVESTIGATE — a non-financial issue a worker can diagnose + propose a fix for
//     (API down, latency, capability, money path, mainnet chain halt).
//   - PREPARE-ONLY — anything touching funds (signer / treasury top-up). The worker
//     computes the amount + drafts the exact steps; it NEVER moves money. Executing
//     the transfer stays operator-only. (Testnet chain halt is text-only: the
//     operator just waits out the reset — no worker task.)
//
// Derived from the probe status + detail (which already carry the human-readable
// specifics), so it works today without the structured solvency/flow blocks.
// Awaiting-data probes never produce a suggestion (telemetry, not an incident).

import type { ProductHealth } from "./product-health.js";
import type { CreateTaskInput } from "./card-types.js";
import { isAwaitingProbe } from "./ops-model.js";

export type OpsSuggestionTone = "warn" | "act" | "tel";

export interface OpsSuggestion {
  id: string;
  tone: OpsSuggestionTone;
  text: string;
  /** Present → render a human-gated "Propose task" button that proposes this. */
  task?: CreateTaskInput;
}

// Ops investigations start in the monitor/reference-agent repo; the operator can
// re-route to the product on the approval gate.
const OPS_INVESTIGATE_REPO = "depre-dev/averray-reference-agent";

/** Compact runway ETA for the suggestion text: "~6h", "~2d". */
function runwayEta(hoursToFloor: number): string {
  if (hoursToFloor <= 0) return "at floor";
  if (hoursToFloor < 48) return `~${Math.round(hoursToFloor)}h`;
  return `~${Math.round(hoursToFloor / 24)}d`;
}

export function opsSuggestions(health: ProductHealth | undefined): OpsSuggestion[] {
  if (!health || !health.enabled || health.checks === 0) return [];
  const byName = new Map(health.probes.map((probe) => [probe.name, probe] as const));
  const out: OpsSuggestion[] = [];
  // A probe is an incident only when it's a REAL degradation — an awaiting-data
  // probe (upstream not wired yet) is telemetry, never a suggestion.
  const live = (name: string) => {
    const p = byName.get(name);
    return p && !isAwaitingProbe(p) ? p : undefined;
  };
  const proposeTask = (prompt: string): CreateTaskInput => ({ agent: "claude", repo: OPS_INVESTIGATE_REPO, prompt });

  // Every incident type below arrives pre-drafted: a specific, probe-cited
  // remediation the operator can act on immediately — an INVESTIGATE task where a
  // worker can help, or a PREPARE-only task for anything touching funds (compute +
  // draft, never a transfer). Ordered most-actionable first.

  // 1. Product API down — the product itself is failing its health check.
  const api = live("product_api");
  if (api && api.status === "red") {
    out.push({
      id: "product-api-down",
      tone: "act",
      text: `Product API down — ${api.detail}.`,
      task: proposeTask(
        `The live product API is failing its health check: "${api.detail}". Confirm from outside (curl /health), check whether a recent deploy regressed it, tail the product logs, find the root cause, and propose the fix — roll back if a deploy caused it.`,
      ),
    });
  }

  // 2. Signer at/below floor — settlement halts. Funds are operator-only, so the
  //    task PREPARES the top-up (compute + draft); it never moves money.
  const signer = live("signer_liquidity");
  if (signer && (signer.status === "red" || /below floor/i.test(signer.detail))) {
    out.push({
      id: "signer-floor",
      tone: signer.status === "red" ? "act" : "warn",
      text: "Signer USDC below floor — top up before the next payout.",
      task: proposeTask(
        `Prepare a signer top-up — do NOT move funds, PREPARE ONLY. The signer is at/below its floor: "${signer.detail}". Compute how much to add to restore a safe buffer (≈ 5× floor) and draft the exact top-up steps/command for the operator to execute.`,
      ),
    });
  }

  // 3. Signer runway — projected to hit the floor. Pre-floor only (hoursToFloor > 0;
  //    the at-floor case above owns 0h). PREPARE task, never moves funds.
  const runwayDanger = (health.solvency?.runway ?? [])
    .filter((p) => (p.status === "red" || p.status === "degraded") && (p.hoursToFloor ?? 0) > 0)
    .sort((a, b) => (a.hoursToFloor ?? 0) - (b.hoursToFloor ?? 0));
  const nearest = runwayDanger[0];
  if (nearest && nearest.hoursToFloor != null) {
    const eta = runwayEta(nearest.hoursToFloor);
    const burn = nearest.burnPerHour != null ? ` (burning ~${nearest.burnPerHour.toFixed(2)} ${nearest.unit}/h)` : "";
    out.push({
      id: "signer-runway",
      tone: nearest.status === "red" ? "act" : "warn",
      text: `${nearest.label} ${eta} to floor — top up before settlement halts.`,
      task: proposeTask(
        `Prepare a signer top-up — do NOT move funds, PREPARE ONLY. ${nearest.label} is projected to reach its ${nearest.floor} ${nearest.unit} floor in ${eta} (current ${nearest.current} ${nearest.unit}${burn}). Compute how much ${nearest.unit} to add to reach a safe buffer (target ≈ 5× the floor) and draft the exact top-up steps/command for the operator to review and execute.`,
      ),
    });
  }

  // 4. Treasury reserve low — rewards can't be funded. Operator-only funds → PREPARE.
  const treasury = live("treasury_liquidity");
  if (treasury && treasury.status === "red") {
    out.push({
      id: "treasury-floor",
      tone: "act",
      text: `Treasury reserve low — ${treasury.detail}. Refill (operator action).`,
      task: proposeTask(
        `Prepare a treasury refill — do NOT move funds, PREPARE ONLY. Treasury probe: "${treasury.detail}". Compute how much to move to restore a safe reserve and draft the exact steps for the operator to execute.`,
      ),
    });
  }

  // 5. Money path — stuck / failed settlements. A worker traces + proposes a fix.
  const money = live("money_path");
  if (money && (money.status === "red" || money.status === "degraded")) {
    out.push({
      id: "money-stuck",
      tone: money.status === "red" ? "act" : "warn",
      text: `Money path — ${money.detail}`,
      task: proposeTask(
        `Investigate the live product money path. Health probe: "${money.detail}". Trace the stuck/failed settlements and propose a fix.`,
      ),
    });
  }

  // 6. Capability degraded — name the capability + why it dropped.
  const caps = live("capabilities");
  if (caps && caps.status === "degraded") {
    out.push({
      id: "capabilities",
      tone: "warn",
      text: `Capabilities — ${caps.detail}. Check config.`,
      task: proposeTask(
        `A product capability is degraded: "${caps.detail}". Identify which capability dropped and why (missing/expired cred, config, or upstream) and propose the config fix.`,
      ),
    });
  }

  // 7. Chain not advancing. Testnet: the operator waits it out (no worker task).
  //    Mainnet: a halt is page-worthy — investigate + escalate.
  const chain = live("chain_height");
  if (chain && chain.status !== "ok" && /advanc|halt|frozen|stall/i.test(chain.detail)) {
    if (health.network === "mainnet") {
      out.push({
        id: "chain-halt",
        tone: "act",
        text: `Chain not advancing (mainnet) — ${chain.detail}. Escalate.`,
        task: proposeTask(
          `MAINNET chain is not advancing: "${chain.detail}" — settlement is down. Check the RPC + chain status, confirm it isn't our endpoint, and escalate / propose the recovery step.`,
        ),
      });
    } else {
      out.push({ id: "chain-frozen", tone: "tel", text: "Chain not advancing — testnet reset, wait it out." });
    }
  }

  // 8. API latency elevated — profile the slow path.
  const latency = live("api_latency");
  if (latency && (latency.status === "red" || latency.status === "degraded")) {
    out.push({
      id: "api-latency",
      tone: latency.status === "red" ? "act" : "warn",
      text: `API latency elevated — ${latency.detail}.`,
      task: proposeTask(
        `Product API latency is elevated: "${latency.detail}". Profile the slow path — RPC round-trips, DB/gateway saturation, recent traffic — and propose what to tune or scale.`,
      ),
    });
  }

  return out;
}

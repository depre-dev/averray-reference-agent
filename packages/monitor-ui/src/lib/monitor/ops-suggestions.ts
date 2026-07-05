// Ops remediation suggestions — pure derivation from product health for the
// co-pilot's "Ops suggestions" box.
//
// Hermes SUGGESTS, never executes. Two kinds:
//   - informational (no task): anything the operator must do themselves —
//     especially anything touching funds (topping up the signer is operator-only).
//   - actionable (carries a `task`): a human-gated proposed task the operator
//     approves; a worker then runs it. Hermes never runs it himself.
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

  const signer = byName.get("signer_liquidity");
  if (signer && !isAwaitingProbe(signer) && (signer.status === "red" || /below floor/i.test(signer.detail))) {
    out.push({
      id: "signer-floor",
      tone: signer.status === "red" ? "act" : "warn",
      text: "Signer USDC below floor — top up before the next payout.",
    });
  }

  // Proactive pre-floor warning from the runway projection — fires BEFORE the
  // balance hits the floor (the signer-floor branch above owns the at-floor case,
  // so we require hoursToFloor > 0). Topping up is operator-only, so the task
  // PREPARES the fix (compute the amount + draft the steps); it never moves funds.
  const runwayDanger = (health.solvency?.runway ?? [])
    .filter((p) => (p.status === "red" || p.status === "degraded") && (p.hoursToFloor ?? 0) > 0)
    .sort((a, b) => (a.hoursToFloor ?? 0) - (b.hoursToFloor ?? 0));
  const nearest = runwayDanger[0];
  if (nearest && nearest.hoursToFloor != null) {
    const eta = runwayEta(nearest.hoursToFloor);
    const burn =
      nearest.burnPerHour != null ? ` (burning ~${nearest.burnPerHour.toFixed(2)} ${nearest.unit}/h)` : "";
    out.push({
      id: "signer-runway",
      tone: nearest.status === "red" ? "act" : "warn",
      text: `${nearest.label} ${eta} to floor — top up before settlement halts.`,
      task: {
        agent: "claude",
        repo: OPS_INVESTIGATE_REPO,
        prompt: `Prepare a signer top-up — do NOT move funds, PREPARE ONLY. ${nearest.label} is projected to reach its ${nearest.floor} ${nearest.unit} floor in ${eta} (current ${nearest.current} ${nearest.unit}${burn}). Compute how much ${nearest.unit} to add to reach a safe buffer (target ≈ 5× the floor) and draft the exact top-up steps/command for the operator to review and execute.`,
      },
    });
  }

  const money = byName.get("money_path");
  if (money && !isAwaitingProbe(money) && (money.status === "red" || money.status === "degraded")) {
    out.push({
      id: "money-stuck",
      tone: money.status === "red" ? "act" : "warn",
      text: `Money path — ${money.detail}`,
      task: {
        agent: "claude",
        repo: OPS_INVESTIGATE_REPO,
        prompt: `Investigate the live product money path. Health probe: ${money.detail}. Trace the stuck/failed settlements and propose a fix.`,
      },
    });
  }

  const chain = byName.get("chain_height");
  if (chain && !isAwaitingProbe(chain) && chain.status === "degraded" && health.network !== "mainnet") {
    out.push({
      id: "chain-frozen",
      tone: "tel",
      text: "Chain not advancing — testnet reset, wait it out.",
    });
  }

  const caps = byName.get("capabilities");
  if (caps && !isAwaitingProbe(caps) && caps.status === "degraded") {
    out.push({
      id: "capabilities",
      tone: "warn",
      text: `Capabilities — ${caps.detail}. Check config.`,
    });
  }

  return out;
}

// O4-PR2 — the routing taxonomy.
//
// A PURE, overridable default Hermes uses to (a) pick codex vs claude for a
// proposed task and (b) tag its risk tier. It grants NO authority: the operator
// still approves every task; this only makes the proposals smart, and gives
// PR3's autopilot the riskTier it reads to decide what may auto-approve vs must
// escalate.
//
// Static per docs/HERMES_ORCHESTRATION_DESIGN.md §O4-C. Learned/data-driven
// routing is A2 (needs the A1 scorecard); this is the static default only.
//
// CONSERVATIVE / escalate-safe: any high-risk signal wins over a Claude signal,
// and a genuinely ambiguous task defaults to claude+low — but anything that
// looks correctness-critical is treated as high-risk → Codex. Never
// under-classify risk.

import type { HermesDecisionRecord } from "./decision-records.js";

export type RoutingAgent = "codex" | "claude";
export type RiskTier = "high" | "low";

export interface RoutingInput {
  repo?: string;
  prompt?: string;
  /** Optional explicit surface label (e.g. "contracts", "ui"). */
  area?: string;
  /** Optional explicit tags. */
  tags?: string[];
}

export interface RoutingDecision {
  agent: RoutingAgent;
  riskTier: RiskTier;
  /** Short human string for the board + the off-device alert. */
  reason: string;
  /** D2 explainability record, when a dynamic router generated one. */
  decisionRecord?: HermesDecisionRecord;
}

interface SurfaceGroup {
  surface: string;
  keywords: string[];
}

// Codex surfaces — correctness-critical, hard to reverse ⇒ HIGH risk (§O4-C).
const HIGH_RISK_SURFACES: SurfaceGroup[] = [
  { surface: "contracts", keywords: ["contract", "contracts", "solidity", ".sol", "abi"] },
  { surface: "chain/settlement", keywords: ["settle", "settlement", "escrow", "on-chain", "onchain", "chain", "reputation sbt", "sbt", "arbitration", "dispute", "substrate", "polkadot", "evm"] },
  { surface: "indexer", keywords: ["indexer", "subquery", "subgraph"] },
  { surface: "XCM", keywords: ["xcm", "cross-chain", "crosschain", "bridge", "relay"] },
  { surface: "treasury/policy", keywords: ["treasury", "policy", "budget", "spend cap"] },
  { surface: "payments", keywords: ["payment", "payout", "reward", "fee", "invoice", "billing"] },
  { surface: "DB migrations", keywords: ["migration", "migrations", "schema change", "alter table", "ddl"] },
  { surface: "deploy/ops", keywords: ["deploy", "deployment", "ops", "infra", "compose", "dockerfile", "ci/cd", "pipeline", "release"] },
  { surface: "secrets/config", keywords: ["secret", "private key", "api key", "mnemonic", "wallet", "signer", "siwe", "credential", "env var", ".env", "token rotation"] },
];

// Claude surfaces — breadth + readability ⇒ low/medium risk (§O4-C).
const CLAUDE_SURFACES: SurfaceGroup[] = [
  { surface: "UI/frontend", keywords: ["ui", "frontend", "front-end", "component", "css", "styling", "layout", "tooltip", "badge", "label", "accessibility", "a11y", "responsive"] },
  { surface: "the monitor", keywords: ["monitor", "board", "drawer", "co-pilot", "copilot", "lane"] },
  { surface: "docs/copy", keywords: ["docs", "documentation", "readme", "copy", "comment", "changelog", "guide"] },
  { surface: "tests", keywords: ["test", "tests", "spec", "vitest", "coverage"] },
  { surface: "refactor/DX", keywords: ["refactor", "cleanup", "rename", "dx", "lint", "typo", "formatting", "tidy"] },
  { surface: "MCP tooling", keywords: ["mcp tool", "tool ergonomics", "tool schema"] },
];

function matchesKeyword(haystack: string, keyword: string): boolean {
  // Keywords with non-word chars (".sol", ".env", "on-chain", "ci/cd") match as
  // literal substrings; plain words match on word boundaries to avoid
  // false hits (e.g. "ops" inside "props").
  if (/[^a-z0-9 ]/.test(keyword) || keyword.includes(" ")) {
    return haystack.includes(keyword);
  }
  return new RegExp(`\\b${keyword}\\b`, "i").test(haystack);
}

function firstSurface(haystack: string, groups: SurfaceGroup[]): string | undefined {
  for (const group of groups) {
    if (group.keywords.some((k) => matchesKeyword(haystack, k))) return group.surface;
  }
  return undefined;
}

/**
 * Classify a proposed task into a default agent + risk tier. Pure + deterministic.
 * High-risk surfaces win (escalate-safe); a recognized Claude surface → claude+low;
 * anything else (ambiguous/general) → claude+low default.
 */
export function classifyTask(input: RoutingInput): RoutingDecision {
  const haystack = [input.prompt, input.area, input.repo, ...(input.tags ?? [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();

  const highSurface = firstSurface(haystack, HIGH_RISK_SURFACES);
  if (highSurface) {
    return {
      agent: "codex",
      riskTier: "high",
      reason: `${highSurface} (correctness-critical) → codex, high-risk`,
    };
  }

  const claudeSurface = firstSurface(haystack, CLAUDE_SURFACES);
  if (claudeSurface) {
    return {
      agent: "claude",
      riskTier: "low",
      reason: `${claudeSurface} → claude, low-risk`,
    };
  }

  return {
    agent: "claude",
    riskTier: "low",
    reason: "general/ambiguous → claude, low-risk (default)",
  };
}

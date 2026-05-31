export type HermesBacklogStream = "O" | "A" | "B" | "C" | "D" | "T";
export type HermesBacklogPriority = "near" | "next" | "later";
export type HermesBacklogRiskTier = "low" | "medium" | "high";
export type HermesBacklogAgent = "codex" | "claude" | "hermes";
export type HermesBacklogTrustLevel = "roadmap_sanctioned" | "discovery_requires_operator";

export interface HermesBacklogBoardGateInput {
  actionNeeded?: number;
  codexNeeded?: number;
  hermesChecking?: number;
  operatorReview?: number;
  releaseQueue?: number;
  deploying?: number;
  running?: number;
  drafts?: number;
}

export interface HermesBacklogItem {
  id: string;
  title: string;
  stream: HermesBacklogStream;
  priority: HermesBacklogPriority;
  status: "design_done" | "follow_up";
  owner: HermesBacklogAgent;
  lane: "codex_needed" | "operator_review" | "hermes_checking";
  riskTier: HermesBacklogRiskTier;
  trustLevel: HermesBacklogTrustLevel;
  score: number;
  scoreSignals: string[];
  dependencyStatus: "ready" | "blocked" | "watch";
  dependencies: string[];
  closeCriteria: string[];
  verificationPath: string[];
  prompt: string;
  source: {
    roadmap: "docs/HERMES_ROADMAP.md";
    designDoc: string;
  };
  autoFlowEligible: boolean;
  requiresOperatorApproval: boolean;
}

export interface HermesBacklogPlan {
  schemaVersion: 1;
  kind: "hermes_backlog_plan";
  generatedAt: string;
  mutates: false;
  headline: string;
  source: {
    roadmap: "docs/HERMES_ROADMAP.md";
    mode: "roadmap_static_catalog";
    note: string;
  };
  cadence: {
    onDemand: true;
    idleEligible: boolean;
    dailyBriefEligible: true;
  };
  boardGate: {
    status: "quiet" | "busy" | "not_supplied";
    reason: string;
    liveWork: HermesBacklogBoardGateInput;
  };
  items: HermesBacklogItem[];
  nextOperatorStep: string;
  safety: {
    proposesOnly: true;
    netNewDiscoveryEscalates: true;
    highRiskRemainsRuleBound: true;
    autoApprovalUnchanged: true;
  };
}

const ROADMAP = "docs/HERMES_ROADMAP.md" as const;

const CATALOG: HermesBacklogItem[] = [
  {
    id: "C1",
    title: "Cross-agent review by default",
    stream: "C",
    priority: "near",
    status: "design_done",
    owner: "claude",
    lane: "codex_needed",
    riskTier: "medium",
    trustLevel: "roadmap_sanctioned",
    score: 92,
    scoreSignals: [
      "C4 inter-agent chat is shipped, so reviewer/builder handoff has a channel",
      "O4 dispatch guardrails are shipped, so the default review path can stay proposes-only",
      "Raises confidence before more autonomy work",
    ],
    dependencyStatus: "ready",
    dependencies: ["O3", "O4", "C4"],
    closeCriteria: [
      "Every eligible builder PR receives an independent cross-agent review request",
      "Review result is attached to the card/thread with clear pass/block language",
      "High-risk surfaces remain on the stricter reviewer-panel path",
    ],
    verificationPath: [
      "Unit-test review request generation and card attribution",
      "Run one synthetic low/medium-risk PR through builder -> reviewer -> Hermes verdict",
      "Confirm no merge/deploy authority changes",
    ],
    prompt:
      "Build C1 cross-agent review default for averray-reference-agent. Use the shipped C4 card-scoped collaboration channel, keep it proposes-only, request an independent review for eligible non-high-risk builder PRs, attach the verdict to the monitor card/thread, and leave merge/deploy human-gated.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_PHASE4_DESIGN.md" },
    autoFlowEligible: true,
    requiresOperatorApproval: true,
  },
  {
    id: "T6",
    title: "Agent-requested tester runs",
    stream: "T",
    priority: "near",
    status: "design_done",
    owner: "codex",
    lane: "codex_needed",
    riskTier: "medium",
    trustLevel: "roadmap_sanctioned",
    score: 88,
    scoreSignals: [
      "T1-T5 are shipped, including auth/session and env-bound mutation profile",
      "Gives builder agents a safe way to ask Hermes for evidence before review",
      "Approval gate keeps browser missions from becoming hidden authority",
    ],
    dependencyStatus: "ready",
    dependencies: ["T1", "T2", "T3", "T5"],
    closeCriteria: [
      "Agents can request a tester run from a card without directly launching it",
      "Operator/Hermes approval is required before the run starts",
      "The mission report returns to the requesting card/thread",
    ],
    verificationPath: [
      "Unit-test request -> approve -> mission creation state changes",
      "Run one read-only approved mission and confirm report attachment",
      "Confirm denied/unapproved requests do not run",
    ],
    prompt:
      "Build T6 agent-requested tester runs for averray-reference-agent. Agents may request a read-only browser mission from a card, but Hermes/operator approval must happen before launch; attach the structured report back to the card/thread and do not change merge/deploy authority.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_AGENT_REQUESTS_AND_ALERTS.md" },
    autoFlowEligible: true,
    requiresOperatorApproval: true,
  },
  {
    id: "T4",
    title: "Tier-2 browser agent runner",
    stream: "T",
    priority: "next",
    status: "design_done",
    owner: "codex",
    lane: "codex_needed",
    riskTier: "medium",
    trustLevel: "roadmap_sanctioned",
    score: 82,
    scoreSignals: [
      "Playwright evidence capture exists, but runner remains shallow compared with a real browsing agent",
      "Improves external-agent realism before broader E2E claims",
      "Depends on the T3/T5 safety shell that is already shipped",
    ],
    dependencyStatus: "ready",
    dependencies: ["T3", "T5"],
    closeCriteria: [
      "A browser-capable tier-2 tester can execute the mission prompt with screenshots and trace evidence",
      "Mutation boundaries are enforced by environment profile",
      "Report schema remains the canonical mission report shape",
    ],
    verificationPath: [
      "Run a fresh-memory mission on a public target",
      "Run an authed testnet mission with preseeded storage state",
      "Inspect trace/screenshot artifacts and structured verdict",
    ],
    prompt:
      "Build T4 tier-2 browser agent runner for averray-reference-agent. Reuse the shipped mission schema, T3 auth session support, and T5 mutation binding; produce Playwright evidence and structured reports without exposing secrets to the model.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_E2E_TESTER_DESIGN.md" },
    autoFlowEligible: true,
    requiresOperatorApproval: true,
  },
  {
    id: "B2",
    title: "Self-healing for non-high-risk failures",
    stream: "B",
    priority: "next",
    status: "design_done",
    owner: "codex",
    lane: "codex_needed",
    riskTier: "medium",
    trustLevel: "roadmap_sanctioned",
    score: 76,
    scoreSignals: [
      "D3 anomaly pause exists, so loops have a fail-safe",
      "Useful once backlog proposals and reviewer feedback are visible",
      "Must stay scoped to non-high-risk fixes with operator-visible evidence",
    ],
    dependencyStatus: "ready",
    dependencies: ["D3", "O4"],
    closeCriteria: [
      "Hermes can propose a bounded retry/fix for non-high-risk failures",
      "High-risk, merge, deploy, rollback, secrets, contracts, and migrations are excluded",
      "D3 suspends autopilot if retries loop or worsen the board state",
    ],
    verificationPath: [
      "Unit-test excluded surfaces and retry limits",
      "Run a synthetic failed low-risk task through one proposed retry",
      "Confirm D3 blocks repeated failure loops",
    ],
    prompt:
      "Build B2 self-healing for non-high-risk failures in averray-reference-agent. Keep it proposes-only and bounded: no high-risk surfaces, no merge/deploy/rollback/secrets/contracts/migrations; use D3 anomaly pause as the loop fail-safe.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_PHASE3_DESIGN.md" },
    autoFlowEligible: true,
    requiresOperatorApproval: true,
  },
  {
    id: "C2",
    title: "Reviewer panel for high-risk work",
    stream: "C",
    priority: "next",
    status: "design_done",
    owner: "claude",
    lane: "operator_review",
    riskTier: "high",
    trustLevel: "roadmap_sanctioned",
    score: 70,
    scoreSignals: [
      "High-risk surfaces are rule-bound and should not be learned-routed",
      "Operator needs richer review context before sign-off",
      "Pairs naturally with C1 after default review is stable",
    ],
    dependencyStatus: "watch",
    dependencies: ["C1", "D2"],
    closeCriteria: [
      "High-risk cards show reviewer evidence grouped by concern",
      "Operator can see why automation stopped and what decision is requested",
      "No line-by-line re-review requirement is implied when code-level checks already ran",
    ],
    verificationPath: [
      "Unit-test panel data shape for secrets/deploy/backend risk",
      "Render monitor panel with synthetic high-risk card",
      "Confirm operator decision remains explicit",
    ],
    prompt:
      "Build C2 reviewer panel for high-risk Hermes cards. Use D2 decision records and existing risk taxonomy to group evidence for operator sign-off; do not change the high-risk rule-bound routing or human approval requirement.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_PHASE4_DESIGN.md" },
    autoFlowEligible: false,
    requiresOperatorApproval: true,
  },
  {
    id: "C3",
    title: "Specialist agents for tests, security, and docs",
    stream: "C",
    priority: "later",
    status: "design_done",
    owner: "claude",
    lane: "codex_needed",
    riskTier: "medium",
    trustLevel: "roadmap_sanctioned",
    score: 58,
    scoreSignals: [
      "Useful after C1/C2 establish reviewer flow",
      "Can increase review quality without expanding authority",
      "Needs capability manifest and attribution to avoid opaque agents",
    ],
    dependencyStatus: "watch",
    dependencies: ["C1", "T7"],
    closeCriteria: [
      "Specialist request types are explicit and attributable",
      "Each specialist has bounded inputs, expected outputs, and no hidden authority",
      "Specialist results attach to the card thread",
    ],
    verificationPath: [
      "Unit-test specialist routing taxonomy",
      "Run one synthetic docs/test/security request each",
      "Confirm results appear in collaboration thread with agent attribution",
    ],
    prompt:
      "Build C3 specialist-agent request foundation for averray-reference-agent: tests, security, and docs specialists as attributed, bounded reviewers that post results to card threads. No authority change.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_PHASE4_DESIGN.md" },
    autoFlowEligible: true,
    requiresOperatorApproval: true,
  },
  {
    id: "T7",
    title: "Tester capabilities manifest follow-up",
    stream: "T",
    priority: "later",
    status: "follow_up",
    owner: "codex",
    lane: "codex_needed",
    riskTier: "low",
    trustLevel: "roadmap_sanctioned",
    score: 54,
    scoreSignals: [
      "Capabilities manifest is still marked design/follow-up in the roadmap",
      "Would help agents know which tester modes are available before requesting runs",
      "Low-risk documentation/API surface if kept read-only",
    ],
    dependencyStatus: "ready",
    dependencies: ["T1", "T3", "T5"],
    closeCriteria: [
      "Manifest lists available mission types, auth modes, mutation modes, and evidence artifacts",
      "Monitor and MCP expose the same read-only contract",
      "Platform helper remains a separate follow-up unless code evidence exists",
    ],
    verificationPath: [
      "Unit-test manifest shape",
      "Confirm monitor and MCP responses agree",
      "Run one tester mission and confirm advertised evidence fields are present",
    ],
    prompt:
      "Build T7 tester capabilities manifest follow-up for averray-reference-agent. Expose a read-only manifest of mission types, auth modes, mutation modes, and evidence artifacts through monitor/MCP; do not overclaim platform-helper pieces.",
    source: { roadmap: ROADMAP, designDoc: "docs/HERMES_AGENT_REQUESTS_AND_ALERTS.md" },
    autoFlowEligible: true,
    requiresOperatorApproval: true,
  },
];

export function getHermesBacklogPlan(input: {
  now?: Date;
  limit?: number;
  board?: HermesBacklogBoardGateInput;
} = {}): HermesBacklogPlan {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const boardGate = summarizeBoardGate(input.board);
  const items = [...CATALOG]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, clampLimit(input.limit));

  return {
    schemaVersion: 1,
    kind: "hermes_backlog_plan",
    generatedAt,
    mutates: false,
    headline: boardGate.status === "busy"
      ? "Hermes has roadmap proposals ready, but live board work should finish first."
      : "Hermes can propose the next roadmap-backed work without changing authority.",
    source: {
      roadmap: ROADMAP,
      mode: "roadmap_static_catalog",
      note: "B1 first slice uses a curated roadmap catalog so runtime containers do not need docs mounted.",
    },
    cadence: {
      onDemand: true,
      idleEligible: boardGate.status !== "busy",
      dailyBriefEligible: true,
    },
    boardGate,
    items,
    nextOperatorStep: "Pick one item, copy its prompt into a proposed task, and approve only when you want an agent to start.",
    safety: {
      proposesOnly: true,
      netNewDiscoveryEscalates: true,
      highRiskRemainsRuleBound: true,
      autoApprovalUnchanged: true,
    },
  };
}

function summarizeBoardGate(board: HermesBacklogBoardGateInput | undefined): HermesBacklogPlan["boardGate"] {
  if (!board) {
    return {
      status: "not_supplied",
      reason: "No live board snapshot was supplied; this is an on-demand roadmap shortlist only.",
      liveWork: {},
    };
  }
  const active = (board.actionNeeded ?? 0)
    + (board.codexNeeded ?? 0)
    + (board.hermesChecking ?? 0)
    + (board.operatorReview ?? 0)
    + (board.deploying ?? 0)
    + (board.running ?? 0);
  if (active > 0) {
    return {
      status: "busy",
      reason: `${active} live card${active === 1 ? "" : "s"} should resolve before Hermes feeds more work.`,
      liveWork: board,
    };
  }
  return {
    status: "quiet",
    reason: "No live blocking/running/review cards were supplied; backlog proposals are eligible.",
    liveWork: board,
  };
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(8, Math.trunc(value ?? 3)));
}

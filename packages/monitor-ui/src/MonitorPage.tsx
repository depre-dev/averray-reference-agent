// Hermes Handoff Monitor — board page (M8')
//
// The live data container: wires useMonitorBoard() (SWR fetch of
// /monitor/v2/board + the SSE LiveStream against /monitor/v2/stream),
// useCardParam() (the ?card= drawer route), and the co-pilot rail's
// collaboration feed to the presentational <BoardView>. A spawned/updated
// card on the SSE feed flows event → applyEventToBoard → SWR cache →
// re-render; the Refresh button revalidates; clicking a card opens its
// drawer; the rail polls /monitor/collaboration and posts scoped
// questions.
//
// The Hermes composer's `/mission <url>` spawns a real browser mission
// by POSTing to /monitor/testbed-missions; the Playwright runner reports
// back through the same v2 board feed, so the new mission card appears
// and updates live.
//
// Auth is handled at the edge (Cloudflare Access), so there is no
// client-side guard here.
//
// Deferred, by milestone:
//   - the degraded TopStrip ("?" KPIs) → M11'

import { useCallback, useMemo } from "react";
import { useMonitorBoard, type UseMonitorBoardOptions } from "./hooks/useMonitorBoard.js";
import { useBacklogSuggestions, type UseBacklogSuggestionsOptions } from "./hooks/useBacklogSuggestions.js";
import { useCardParam } from "./hooks/useCardParam.js";
import type { UseCollaborationOptions } from "./hooks/useCollaboration.js";
import { useActionAlerts, type UseActionAlertsOptions } from "./hooks/useActionAlerts.js";
import { useAutonomyMode, type UseAutonomyModeOptions } from "./hooks/useAutonomyMode.js";
import { kpiCounts } from "./lib/monitor/board-state.js";
import type { BoardCard, CreateTaskInput } from "./lib/monitor/card-types.js";
import { missionLaunchBody, type MissionSpawnInput, type SaveTestSuiteInput } from "./lib/monitor/mission-launch.js";
import { BoardView } from "./components/BoardView.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

const MISSIONS_URL = "/monitor/testbed-missions";
const SUITES_URL = "/monitor/suites";
const CODEX_TASKS_URL = "/monitor/codex-tasks";
const SELF_HEALING_PROPOSALS_URL = "/monitor/self-healing-proposals";
const ALERT_MUTE_URL = "/monitor/alert-mute";

export type AlertMuteBody = { untilMs: number } | { muted: false };

export interface MonitorPageProps {
  /** Override the live wiring (fetcher, EventSource, storage) for tests. */
  options?: UseMonitorBoardOptions;
  /** Override the read-only backlog-suggestions endpoint wiring for tests. */
  backlogSuggestions?: UseBacklogSuggestionsOptions;
  /** Override the /mission spawn (defaults to POST /monitor/testbed-missions). */
  onSpawnMission?: (input: MissionSpawnInput) => void;
  /** Override saving a named suite (defaults to POST /monitor/suites). */
  onSaveSuite?: (input: SaveTestSuiteInput) => void;
  /** Override running a named suite (defaults to POST /monitor/suites/:id/run). */
  onRunSuite?: (id: string) => void;
  /** Override approving a requested suite (defaults to POST /monitor/suites/:id/approve). */
  onApproveSuite?: (id: string) => void;
  /** Override dismissing a requested suite (defaults to POST /monitor/suites/:id/dismiss). */
  onDismissSuite?: (id: string) => void;
  /** Override the /claude propose (defaults to POST /monitor/codex-tasks). */
  onSpawnClaudeTask?: (repo: string, prompt: string) => void;
  /** Override the create-task dispatch (defaults to POST /monitor/codex-tasks propose). */
  onCreateTask?: (input: CreateTaskInput) => void;
  /** Override the approve dispatch (defaults to POST /monitor/codex-tasks approve). */
  onApproveTask?: (id: string) => void;
  /** Override persisted card dismiss. */
  onDismissCard?: (card: BoardCard) => void;
  /** Override persisted card snooze. */
  onSnoozeCard?: (card: BoardCard, untilMs: number) => void;
  /** Override the tester mission approval (defaults to POST /monitor/testbed-missions/:id/approve). */
  onApproveMission?: (id: string) => void;
  /** Override requested-mission dismiss (defaults to POST /monitor/testbed-missions/:id/dismiss). */
  onDismissMission?: (id: string) => void;
  /** Override the drawer mission re-run (defaults to POST /monitor/testbed-missions). */
  onRerunMission?: (targetUrl: string, freshness: "fresh" | "memory") => void;
  /** Override failed-mission acknowledgement (defaults to POST /monitor/testbed-missions/:id/accept-failure). */
  onAcceptMissionFailure?: (id: string) => void;
  /** Override failed-mission issue creation (defaults to POST /monitor/testbed-missions/:id/open-issue). */
  onOpenMissionIssue?: (id: string) => void;
  /** Override the co-pilot collaboration wiring (defaults to live polling). */
  collaboration?: UseCollaborationOptions;
  /** Override the action-alert wiring (audio/notification/storage) for tests. */
  alerts?: UseActionAlertsOptions;
  /** Override the server-side mute POST (D4 off-device alerts) for tests. */
  onAlertMute?: (body: AlertMuteBody) => void;
  /** Override the autonomy-mode wiring (GET/POST /monitor/autonomy-mode) for tests. */
  autonomy?: UseAutonomyModeOptions;
}

export function MonitorPage({
  options,
  backlogSuggestions,
  onSpawnMission = defaultSpawnMission,
  onSaveSuite = defaultSaveSuite,
  onRunSuite = defaultRunSuite,
  onApproveSuite = defaultApproveSuite,
  onDismissSuite = defaultDismissSuite,
  onSpawnClaudeTask = defaultSpawnClaudeTask,
  onCreateTask = defaultCreateTask,
  onApproveTask = defaultApproveTask,
  onDismissCard = defaultDismissCard,
  onSnoozeCard = defaultSnoozeCard,
  onApproveMission = defaultApproveMission,
  onDismissMission = defaultDismissMission,
  onRerunMission = defaultRerunMission,
  onAcceptMissionFailure = defaultAcceptMissionFailure,
  onOpenMissionIssue = defaultOpenMissionIssue,
  collaboration = {},
  alerts,
  onAlertMute = defaultPostAlertMute,
  autonomy,
}: MonitorPageProps = {}) {
  const { board, status, refresh } = useMonitorBoard(options);
  const { data: backlogSuggestionsData } = useBacklogSuggestions(backlogSuggestions);
  const { cardId, setCard, clearCard } = useCardParam();
  const { mode: autonomyMode, setAutopilot, setSupervised } = useAutonomyMode(autonomy);

  // The action-needed count drives all three notification tiers (§17).
  const actionCount = useMemo(() => kpiCounts(board?.cards ?? []).action, [board?.cards]);
  const { muted, mute, unmute } = useActionAlerts(actionCount, alerts);

  // D4: mute the browser alerts AND the server-side off-device bridge together,
  // so muting on the board also silences the Slack/push alert.
  const muteEverywhere = useCallback(
    (untilMs: number) => {
      mute(untilMs);
      onAlertMute({ untilMs });
    },
    [mute, onAlertMute],
  );
  const unmuteEverywhere = useCallback(() => {
    unmute();
    onAlertMute({ muted: false });
  }, [unmute, onAlertMute]);

  return (
    <ErrorBoundary>
      <BoardView
        board={board}
        backlogSuggestions={backlogSuggestionsData}
        status={status}
        onRefresh={refresh}
        focusedCardId={cardId}
        onCardClick={setCard}
        onCardClose={clearCard}
        onCardNavigate={setCard}
        onSpawnMission={onSpawnMission}
        onSaveSuite={onSaveSuite}
        onRunSuite={onRunSuite}
        onApproveSuite={onApproveSuite}
        onDismissSuite={onDismissSuite}
        onSpawnClaudeTask={onSpawnClaudeTask}
        onCreateTask={onCreateTask}
        onApproveTask={onApproveTask}
        onDismissCard={onDismissCard}
        onSnoozeCard={onSnoozeCard}
        onApproveMission={onApproveMission}
        onDismissMission={onDismissMission}
        onRerunMission={onRerunMission}
        onAcceptMissionFailure={onAcceptMissionFailure}
        onOpenMissionIssue={onOpenMissionIssue}
        collaboration={collaboration}
        onMute={muteEverywhere}
        onUnmute={unmuteEverywhere}
        muted={muted}
        onSetAutopilot={setAutopilot}
        onSetSupervised={setSupervised}
        autonomyMode={autonomyMode}
      />
    </ErrorBoundary>
  );
}

function defaultSaveSuite(input: SaveTestSuiteInput): void {
  void fetch(SUITES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function defaultRunSuite(id: string): void {
  void fetch(`${SUITES_URL}/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function defaultApproveSuite(id: string): void {
  void fetch(`${SUITES_URL}/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function defaultDismissSuite(id: string): void {
  void fetch(`${SUITES_URL}/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

/**
 * Spawn a browser mission against `url`. The slack-operator's
 * /monitor/testbed-missions runner accepts `{ targetUrl }`, runs a fresh
 * Playwright agent, and surfaces the result as a mission card on the v2
 * board — so the spawned card appears and updates through the live feed.
 * Fire-and-forget: the board feed, not this call, drives the UI.
 */
function defaultSpawnMission(input: MissionSpawnInput): void {
  void fetch(MISSIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(missionSpawnBody(input)),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function missionSpawnBody(input: MissionSpawnInput): Record<string, unknown> {
  return missionLaunchBody(input);
}

/**
 * Re-run a mission from the drawer footer. Same endpoint as a spawn, plus a
 * freshness flag: "fresh" → a new agent with no prior context (freshMemory),
 * "memory" → the agent reads the last terminal report as context. Fire-and-
 * forget; the new mission card arrives on the board feed.
 */
function defaultRerunMission(targetUrl: string, freshness: "fresh" | "memory"): void {
  void fetch(MISSIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl, freshMemory: freshness === "fresh" }),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

/**
 * Propose a greenfield Claude task. POSTs `{ agent: "claude", repo, prompt }`
 * to the slack-operator's /monitor/codex-tasks (the propose action), which
 * enqueues it as a `proposed` task card on the v2 board. This only PROPOSES:
 * the task still needs an explicit operator approval before the Claude runner
 * claims it and opens a PR — the human gate is unchanged. Fire-and-forget; the
 * board feed, not this call, drives the UI.
 */
function defaultSpawnClaudeTask(repo: string, prompt: string): void {
  void fetch(CODEX_TASKS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "propose", agent: "claude", repo, prompt }),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

/**
 * Propose a task (O3 board dispatch). POSTs `{ action: "propose", agent, repo,
 * prompt, pullRequestNumber? }` to /monitor/codex-tasks. Like /claude it only
 * PROPOSES — the task lands `proposed` in codex-needed and the operator must
 * approve before any runner claims it. Fire-and-forget; the board feed drives
 * the UI.
 */
function defaultCreateTask(input: CreateTaskInput): void {
  void fetch(CODEX_TASKS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "propose", ...input }),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

/**
 * Approve a proposed task — the human gate (proposed → approved). POSTs
 * `{ action: "approve", id }`. Only the operator triggers this; never
 * auto-approved. The runner claims it after approval and the board feed
 * reflects the lifecycle.
 */
function defaultApproveTask(id: string): void {
  void fetch(CODEX_TASKS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", id }),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function defaultDismissCard(card: BoardCard): void {
  const base = monitorCardActionBase(card);
  if (!base) return;
  void fetch(`${base}/${encodeURIComponent(card.id)}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* optimistic local hide already applied; next poll is the source of truth */
  });
}

function defaultSnoozeCard(card: BoardCard, untilMs: number): void {
  const base = monitorCardActionBase(card);
  if (!base) return;
  void fetch(`${base}/${encodeURIComponent(card.id)}/snooze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ untilMs }),
  }).catch(() => {
    /* optimistic local hide already applied; next poll is the source of truth */
  });
}

function monitorCardActionBase(card: BoardCard): string | undefined {
  if (card.type !== "task") return undefined;
  return card.correlationId?.startsWith("self-heal:") ? SELF_HEALING_PROPOSALS_URL : CODEX_TASKS_URL;
}

/**
 * Approve a requested tester mission — the T6 board gate (requested → ready).
 * Agents can request a run, but only this operator action lets the runner
 * claim it. Fire-and-forget; the board feed reflects the lifecycle.
 */
function defaultApproveMission(id: string): void {
  void fetch(`${MISSIONS_URL}/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function defaultDismissMission(id: string): void {
  void fetch(`${MISSIONS_URL}/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* optimistic local hide already applied; next poll is the source of truth */
  });
}

function defaultAcceptMissionFailure(id: string): void {
  void fetch(`${MISSIONS_URL}/${encodeURIComponent(id)}/accept-failure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

function defaultOpenMissionIssue(id: string): void {
  void fetch(`${MISSIONS_URL}/${encodeURIComponent(id)}/open-issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}

/**
 * Set the SERVER-side alert mute (D4) so muting on the board also silences the
 * off-device Slack/push alert. Fire-and-forget; failure just means the
 * off-device mute didn't apply — the browser mute still did.
 */
function defaultPostAlertMute(body: AlertMuteBody): void {
  void fetch(ALERT_MUTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    /* the browser mute still applied; off-device mute is best-effort */
  });
}

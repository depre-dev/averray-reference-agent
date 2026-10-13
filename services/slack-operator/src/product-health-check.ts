// One product-health tick, extracted so a test can run the same function index runs.
//
// Shared writes go through `ctx.live()`. An abandoned tick — the watchdog has
// already started the next one — must not publish, hydrate, or narrate over it.

import { logger } from "@avg/mcp-common";
import { deriveOpsVerdict } from "@avg/schemas";

import {
  ARRIVAL_ALERTS_MAX_SENDS_PER_POLL,
  ARRIVAL_ALERTS_SLACK_TIMEOUT_MS,
  arrivalAlertHold,
  arrivalAlertsBoardStatus,
  arrivalAlertsSlackEnabled,
  deliverArrivalAlerts,
  readArrivalAlerts,
} from "./arrival-alerts.js";
import {
  slackAlertChannel,
  getServerAlertMuteUntilMs,
  inQuietHours,
  minuteOfDayForOffset,
  type AlertChannel,
  type AlertPayload,
  type QuietHours,
} from "./alert-bridge.js";
import { readArrivalsFeed } from "./arrivals-feed.js";
import {
  bankChangeText,
  bankMovesLineMode,
  openBankMovesCursor,
  projectBankMovesReading,
  readBankMoves,
  unavailableBankMoves,
  type BankMoveLine,
  type BankMovesCursorState,
} from "./bank-moves-feed.js";
import { recordBuzzDelivery, type BuzzDeliveryState } from "./buzz-delivery.js";
import { publishNarration, readBuzzConfig, type BuzzConfig } from "./buzz-client.js";
import { depositPoolUrlFromBankFeed, readDepositPoolFeed } from "./deposit-pool-feed.js";
import { composeConversationalDigest } from "./digest-voice.js";
import { isBurnUnmeasurable, measuredGasBurn } from "./gas-burn-rate.js";
import { readAdminGithubAuthors } from "./github-authors.js";
import {
  buildMorningDigest,
  digestDue,
  digestFactStrings,
  readDigestSchedule,
  type DigestSchedule,
} from "./morning-digest.js";
import { recordCollaborationMessage } from "./monitor-collab.js";
import { requestHermesCompletion } from "./monitor-hermes-voice.js";
import { probeLabel } from "./ops-voice.js";
import { decideOpsNarration, type OpsStatus } from "./ops-narration.js";
import {
  buildRemediationAlert,
  decideRpcRemediation,
  describeRemediationStatus,
  initialRpcRemediationState,
  loadRemediationConfig,
  type RemediationStatus,
} from "./ops-remediation.js";
import {
  appendHistory,
  buildRunwayAlertPayload,
  collectProductHealthProbes,
  decideRunwayAlert,
  deriveLiquidityRunway,
  deriveProductHealthHistory,
  initialProductHealthAlertState,
  initialRunwayAlertState,
  loadProductHealthConfig,
  runProductHealthOnce,
  type ChainAdvance,
  type ProbeResult,
  type ProductHealthAlertState,
  type ProductHealthIncident,
  type ProductHealthSnapshot,
  type ProductHealthSnapshotBlocks,
  type RunwayAlertState,
} from "./product-health.js";
import { appendIncidents, readIncidents, reconcileIncidents } from "./product-health-incidents.js";
import {
  PROBE_DEADLINE_MS,
  ProductHealthTickGate,
  closeOpenStuckTickIncidents,
  decideMonitorRefreshAlert,
  monitorRefreshAlertText,
  productHealthRefreshSuppressed,
  runGuardedProductHealthTick,
  runWithDeadline,
  type GuardedTickContext,
} from "./product-health-tick.js";
import { decideProbeTransitions, type ProbeTransitionDecision } from "./probe-transitions.js";
import type { TransportFailureRun } from "./probe-transport.js";
import { buildSocialQueueLine, readSocialQueue } from "./social-queue.js";
import { readSocialSignal } from "./social-signal.js";

const PRODUCT_HEALTH_HISTORY_MAX = 60;
const PRODUCT_HEALTH_INCIDENT_MAX = 200;

/** Hermes digest replies must finish inside the 20s post step, or they are discarded and still billed. */
export const DIGEST_COMPLETION_TIMEOUT_MS = 18_000;

/**
 * Reader-level backstop, past the probe deadline. The probe deadline is what
 * the board reports. If that wrapper is removed, the reader still has to be
 * past PROBE_DEADLINE_MS before it can settle on its own.
 */
export const FEED_READER_BACKSTOP_MS = PROBE_DEADLINE_MS + 1_000;

export function isMonitorRefreshPayload(payload: AlertPayload): boolean {
  return payload.text.includes("monitor not refreshing");
}

/** D4 and arrival channels. A 2xx after the 4s race is still recorded. */
export function createProductHealthSlackChannels(input: {
  webhookUrl?: string;
  onRefreshDelivered: () => void;
  onArrivalDelivered: (id: string) => void;
}): { alertChannel: AlertChannel; arrivalAlertChannel: AlertChannel } {
  return {
    alertChannel: slackAlertChannel(input.webhookUrl, {
      timeoutMs: ARRIVAL_ALERTS_SLACK_TIMEOUT_MS,
      onLateSuccess: (payload) => {
        if (isMonitorRefreshPayload(payload)) input.onRefreshDelivered();
      },
    }),
    arrivalAlertChannel: slackAlertChannel(input.webhookUrl, {
      timeoutMs: ARRIVAL_ALERTS_SLACK_TIMEOUT_MS,
      onLateSuccess: (payload) => {
        const id = payload.items[0]?.id;
        if (id) input.onArrivalDelivered(id);
      },
    }),
  };
}

export interface ProductHealthCheckState {
  history: ProductHealthSnapshot[];
  incidents: ProductHealthIncident[];
  incidentsHydrated: boolean;
  chainAdvance?: ChainAdvance;
  transportRun?: TransportFailureRun;
  snapshot?: ProductHealthSnapshotBlocks;
  remediation?: RemediationStatus;
  heartbeatStartedAt: number | null;
  refreshPaged: boolean;
  /** A refresh POST is in flight. Do not dispatch a second one until it settles. */
  refreshPageInFlight: boolean;
  previousCompletedAt: number | null;
  alertState: ProductHealthAlertState;
  runwayAlertState: RunwayAlertState;
  rpcRemediationState: ReturnType<typeof initialRpcRemediationState>;
  lastRemediationReason?: string;
  prevProductHealthStatus: OpsStatus;
  lastOpsNarrationPostedAtMs: number;
  opsNarrationRedAnnounced?: boolean;
  prevProbes: Map<string, ProbeResult>;
  postedProbeKeys: Set<string>;
  probeStreaks: Map<string, number>;
  buzzDeliveryState: BuzzDeliveryState;
  morningDigestProblemLogged: boolean;
  morningDigestSentLocalDate: string | null;
  /** Exclusive cursor for GET /admin/ops/bank-moves. Absent until the first tick. */
  bankMovesCursor?: BankMovesCursorState;
  /** Lines already accepted. A failed poll does not publish these as current. */
  bankMovesAccumulated?: BankMoveLine[];
}

export function createProductHealthCheckState(): ProductHealthCheckState {
  return {
    history: [],
    incidents: [],
    incidentsHydrated: false,
    heartbeatStartedAt: null,
    refreshPaged: false,
    refreshPageInFlight: false,
    previousCompletedAt: null,
    alertState: initialProductHealthAlertState(),
    runwayAlertState: initialRunwayAlertState(),
    rpcRemediationState: initialRpcRemediationState(),
    prevProductHealthStatus: "unknown",
    lastOpsNarrationPostedAtMs: 0,
    prevProbes: new Map(),
    postedProbeKeys: new Set(),
    probeStreaks: new Map(),
    buzzDeliveryState: {},
    morningDigestProblemLogged: false,
    morningDigestSentLocalDate: null,
  };
}

export interface ProductHealthCheckDeps {
  state: ProductHealthCheckState;
  gate: ProductHealthTickGate;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  enabled?: boolean;
  intervalMs: number;
  cooldownMs: number;
  quietHours?: QuietHours;
  quietHoursTzOffsetMin?: number;
  deriveSigner?: () => string | undefined;
  getAdminReadSession?: () => Promise<{ token: string }>;
  alertChannel: AlertChannel;
  arrivalAlertChannel: AlertChannel;
  log?: typeof logger;
  readIncidents?: typeof readIncidents;
  appendIncidents?: typeof appendIncidents;
  readSocialQueue?: typeof readSocialQueue;
  readSocialSignal?: typeof readSocialSignal;
  recordCollaboration?: typeof recordCollaborationMessage;
  requestCompletion?: typeof requestHermesCompletion;
  publishNarration?: typeof publishNarration;
  readBuzzConfig?: (env?: NodeJS.ProcessEnv) => { config: BuzzConfig | null; problem?: string | null };
  digestSchedule?: DigestSchedule;
  decideProbeTransitions?: typeof decideProbeTransitions;
  readDigestSent?: () => string | null;
  writeDigestSent?: (localDate: string) => void;
}

function monitorUrl(env: NodeJS.ProcessEnv): string {
  const value = env.SLACK_OPERATOR_MONITOR_URL?.trim();
  return value && value.length > 0 ? value : "https://monitor.averray.com/monitor";
}

export async function runProductHealthCheck(deps: ProductHealthCheckDeps): Promise<void> {
  if (deps.enabled === false) return;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? logger;
  const state = deps.state;
  const quietOffset = deps.quietHoursTzOffsetMin ?? 0;
  const readIncidentsFn = deps.readIncidents ?? readIncidents;
  const appendIncidentsFn = deps.appendIncidents ?? appendIncidents;
  const readSocialQueueFn = deps.readSocialQueue ?? readSocialQueue;
  const readSocialSignalFn = deps.readSocialSignal ?? readSocialSignal;
  const recordCollaboration = deps.recordCollaboration ?? recordCollaborationMessage;
  const requestCompletion = deps.requestCompletion ?? requestHermesCompletion;
  const publish = deps.publishNarration ?? publishNarration;
  const buzzConfigOf = deps.readBuzzConfig ?? readBuzzConfig;
  const transitionsOf = deps.decideProbeTransitions ?? decideProbeTransitions;
  const deriveSigner = deps.deriveSigner ?? (() => undefined);
  const getSession = deps.getAdminReadSession ?? (async () => ({ token: "" }));

  if (state.heartbeatStartedAt == null) state.heartbeatStartedAt = Date.now();
  const refreshBoardUrl = monitorUrl(env);
  const refreshNowMs = Date.now();
  const refreshSuppression = productHealthRefreshSuppressed({
    muteUntilMs: getServerAlertMuteUntilMs(),
    nowMs: refreshNowMs,
    quiet: inQuietHours(
      minuteOfDayForOffset(refreshNowMs, quietOffset),
      deps.quietHours,
    ),
  });
  const refreshDecision = decideMonitorRefreshAlert({
    enabled: true,
    lastCompletedAtMs: state.history[state.history.length - 1]?.at ?? null,
    previousCompletedAtMs: state.previousCompletedAt,
    heartbeatStartedAtMs: state.heartbeatStartedAt,
    nowMs: refreshNowMs,
    checkIntervalMs: deps.intervalMs,
    paged: state.refreshPaged,
    muted: refreshSuppression.muted,
    quiet: refreshSuppression.quiet,
  });
  if (!refreshDecision.page) {
    state.refreshPaged = refreshDecision.paged;
  } else if (!state.refreshPageInFlight && refreshDecision.sinceMs != null) {
    const sinceMs = refreshDecision.sinceMs;
    // The latch flips only after Slack accepts the post. A timeout or a
    // non-2xx leaves the episode open so the next tick can page it.
    state.refreshPageInFlight = true;
    void deps.alertChannel.dispatch({
      count: 1,
      items: [],
      boardUrl: refreshBoardUrl,
      text: monitorRefreshAlertText(sinceMs, refreshBoardUrl),
    }).then(
        (sent) => {
        state.refreshPageInFlight = false;
        if (sent) state.refreshPaged = true;
        if (!sent) log.warn({ sinceMs }, "product_health_refresh_alert_not_sent");
      },
      (error: unknown) => {
        state.refreshPageInFlight = false;
        log.warn({ err: error, sinceMs }, "product_health_refresh_alert_failed");
      },
    );
  }

  await runGuardedProductHealthTick(deps.gate, async (ctx) => {
    try {
      await runTickBody({
        deps,
        env,
        fetchImpl,
        log,
        state,
        quietOffset,
        readIncidentsFn,
        appendIncidentsFn,
        readSocialQueueFn,
        readSocialSignalFn,
        recordCollaboration,
        requestCompletion,
        publish,
        buzzConfigOf,
        transitionsOf,
        deriveSigner,
        getSession,
        refreshBoardUrl,
        ctx,
      });
    } catch (error) {
      log.error({ err: error }, "product_health_probe_failed");
    }
  });
}

async function runTickBody(input: {
  deps: ProductHealthCheckDeps;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  log: typeof logger;
  state: ProductHealthCheckState;
  quietOffset: number;
  readIncidentsFn: typeof readIncidents;
  appendIncidentsFn: typeof appendIncidents;
  readSocialQueueFn: typeof readSocialQueue;
  readSocialSignalFn: typeof readSocialSignal;
  recordCollaboration: typeof recordCollaborationMessage;
  requestCompletion: typeof requestHermesCompletion;
  publish: typeof publishNarration;
  buzzConfigOf: (env?: NodeJS.ProcessEnv) => { config: BuzzConfig | null; problem?: string | null };
  transitionsOf: (decision: Parameters<typeof decideProbeTransitions>[0]) => ProbeTransitionDecision;
  deriveSigner: () => string | undefined;
  getSession: () => Promise<{ token: string }>;
  refreshBoardUrl: string;
  ctx: GuardedTickContext;
}): Promise<void> {
  const {
    deps, env, fetchImpl, log, state, quietOffset, ctx,
    readIncidentsFn, appendIncidentsFn, readSocialQueueFn, readSocialSignalFn,
    recordCollaboration, requestCompletion, publish, buzzConfigOf, transitionsOf,
    deriveSigner, getSession, refreshBoardUrl,
  } = input;
  const phConfig = loadProductHealthConfig(env);
  const signerAddress = phConfig.signerAddress ?? deriveSigner();
  const remediationConfig = loadRemediationConfig(env, phConfig.rpcUrl);
  const activeRpc = remediationConfig.endpoints[state.rpcRemediationState.activeIndex] ?? phConfig.rpcUrl;
  const arrivalPaging = arrivalAlertsSlackEnabled(env);
  const readerTimeout = { timeoutMs: FEED_READER_BACKSTOP_MS };
  const bankMovesCursor = openBankMovesCursor(Date.now(), state.bankMovesCursor);
  state.bankMovesCursor = bankMovesCursor;
  const bankMovesAccumulated = state.bankMovesAccumulated ?? [];
  const [collection, arrivals, depositPool, adminAuthors, arrivalAlerts, bankMoves] = await Promise.all([
    collectProductHealthProbes({ ...phConfig, signerAddress, rpcUrl: activeRpc }, fetchImpl, {
      ...(state.chainAdvance ? { advance: state.chainAdvance } : {}),
      nowMs: Date.now(),
      previousSubmittedNotSettled: state.snapshot?.flow?.submittedNotSettled,
      ...(state.transportRun ? { transportRun: state.transportRun } : {}),
      deadlineMs: PROBE_DEADLINE_MS,
      pending: deps.gate,
      log,
    }),
    runWithDeadline({
      name: "arrivals",
      pending: deps.gate,
      log,
      run: () => readArrivalsFeed({ baseUrl: phConfig.apiBaseUrl, fetchImpl, ...readerTimeout }),
      onTimeout: (detail) => ({ unavailable: `arrivals feed ${detail}` }),
    }),
    runWithDeadline({
      name: "deposit_pool",
      pending: deps.gate,
      log,
      run: () => readDepositPoolFeed({
        url: depositPoolUrlFromBankFeed(phConfig.bankFeedUrl),
        fetchImpl,
        ...readerTimeout,
      }),
      onTimeout: (detail) => ({ unavailable: `deposit pool ${detail}` }),
    }),
    runWithDeadline({
      name: "github_authors",
      pending: deps.gate,
      log,
      run: () => readAdminGithubAuthors({
        ...(phConfig.apiBaseUrl ? { baseUrl: phConfig.apiBaseUrl } : {}),
        getSession,
        fetchImpl,
        ...readerTimeout,
      }),
      onTimeout: () => ({ warning: null, block: null, unavailable: "timeout" as const }),
    }),
    runWithDeadline({
      name: "arrival_alerts",
      pending: deps.gate,
      log,
      run: () => readArrivalAlerts({
        ...(phConfig.apiBaseUrl ? { baseUrl: phConfig.apiBaseUrl } : {}),
        getSession,
        fetchImpl,
        ...readerTimeout,
      }),
      onTimeout: () => ({
        ready: [],
        pending: [],
        unavailable: "timeout" as const,
        stale: false,
        at: Date.now(),
        ageMs: 0,
      }),
    }),
    runWithDeadline({
      name: "bank_moves",
      pending: deps.gate,
      log,
      run: () => readBankMoves({
        baseUrl: phConfig.apiBaseUrl,
        getSession,
        fetchImpl,
        cursor: bankMovesCursor,
        accumulated: bankMovesAccumulated,
        ...readerTimeout,
      }),
      onTimeout: () => unavailableBankMoves(bankMovesCursor, bankMovesAccumulated),
    }),
  ]);
  if (!ctx.live()) return;
  state.chainAdvance = collection.chainAdvance;
  state.transportRun = collection.transportRun;
  state.bankMovesCursor = bankMoves.cursor;
  state.bankMovesAccumulated = bankMoves.accumulated;
  const servedWarning = collection.snapshot.githubAuthors?.warning ?? adminAuthors.warning;
  state.snapshot = {
    ...collection.snapshot,
    bankMoves: projectBankMovesReading(bankMoves.reading, bankMovesLineMode(env)),
    arrivals,
    depositPool,
    githubAuthors: {
      warning: servedWarning,
      block: adminAuthors.block,
      unavailable: adminAuthors.unavailable ?? (adminAuthors.block ? null : "missing"),
      at: adminAuthors.at ?? null,
      ageMs: adminAuthors.ageMs ?? null,
      ...(adminAuthors.stale ? { stale: true } : {}),
    },
    arrivalAlerts: arrivalAlertsBoardStatus(
      arrivalAlerts,
      arrivalPaging,
      arrivalAlertHold({
        nowMs: Date.now(),
        nowMinuteOfDay: minuteOfDayForOffset(Date.now(), quietOffset),
        ...(getServerAlertMuteUntilMs() > 0 ? { muteUntilMs: getServerAlertMuteUntilMs() } : {}),
        ...(deps.quietHours ? { quietHours: deps.quietHours } : {}),
      }),
      Boolean(env.SLACK_WEBHOOK_URL?.trim()),
    ),
  };
  ctx.markPublished();
  // Not awaited. Awaiting this after publish holds the tick for the Slack bound.
  if (ctx.live() && arrivalPaging && !arrivalAlerts.unavailable && !arrivalAlerts.stale) {
    const arrivalNow = Date.now();
    void runWithDeadline({
      name: "arrival_alert_delivery",
      log,
      deadlineMs: ARRIVAL_ALERTS_SLACK_TIMEOUT_MS * ARRIVAL_ALERTS_MAX_SENDS_PER_POLL,
      run: () => deliverArrivalAlerts({
        reading: arrivalAlerts,
        alert: (payload) => deps.arrivalAlertChannel.dispatch(payload),
        boardUrl: refreshBoardUrl,
        nowMs: arrivalNow,
        nowMinuteOfDay: minuteOfDayForOffset(arrivalNow, quietOffset),
        ...(getServerAlertMuteUntilMs() > 0 ? { muteUntilMs: getServerAlertMuteUntilMs() } : {}),
        ...(deps.quietHours ? { quietHours: deps.quietHours } : {}),
      }),
      onTimeout: () => ({ sent: 0, held: null }),
    }).catch((error: unknown) => {
      log.warn({ err: error }, "arrival_alerts_delivery_failed");
    });
  }
  const remediation = decideRpcRemediation({
    rpcHealthy: collection.rpcOk,
    state: state.rpcRemediationState,
    config: remediationConfig,
    nowMs: Date.now(),
  });
  if (!ctx.live()) return;
  state.rpcRemediationState = remediation.state;
  const remediationAlert = buildRemediationAlert(remediation.outcome, refreshBoardUrl);
  if (remediationAlert) {
    await ctx.post("remediationAlert", () => deps.alertChannel.dispatch(remediationAlert), false);
  }
  if (!ctx.live()) return;
  if (remediation.outcome.kind === "failover" || remediation.outcome.kind === "escalate") {
    state.lastRemediationReason = remediation.outcome.reason;
  } else if (remediation.outcome.kind === "resolved") {
    state.lastRemediationReason = undefined;
  }
  state.remediation = describeRemediationStatus({
    config: remediationConfig,
    state: state.rpcRemediationState,
    lastReason: state.lastRemediationReason,
  });
  const result = await ctx.post("runProductHealthOnce", () => runProductHealthOnce({
    runProbes: async () => collection.probes,
    getSnapshot: () => state.snapshot,
    alert: (payload) => deps.alertChannel.dispatch(payload),
    boardUrl: refreshBoardUrl,
    nowMs: () => Date.now(),
    getAlertState: () => state.alertState,
    setAlertState: (next) => {
      if (!ctx.live()) return;
      state.alertState = next;
    },
    cooldownMs: deps.cooldownMs,
  }), null);
  if (!result || !ctx.live()) return;
  const signerPools = collection.snapshot.solvency?.pools ?? [];
  const signerUsdcSample = signerPools.find((pool) => pool.key === "reward_bank")?.amount ?? null;
  const signerGasSample = signerPools.find((pool) => pool.key === "signer_gas")?.amount ?? null;
  if (!ctx.live()) return;
  state.previousCompletedAt = state.history[state.history.length - 1]?.at ?? null;
  state.history = appendHistory(
    state.history,
    {
      at: Date.now(),
      status: result.status,
      probes: result.evaluation.probes,
      latencyMs: collection.latencyMs ?? null,
      signerUsdc: signerUsdcSample,
      signerGas: signerGasSample,
    },
    PRODUCT_HEALTH_HISTORY_MAX,
  );
  try {
    if (!state.incidentsHydrated) {
      const persisted = await ctx.post("readIncidents", () => readIncidentsFn(), null);
      if (ctx.live() && persisted) {
        const byId = new Map(persisted.map((incident) => [incident.id, incident]));
        for (const incident of state.incidents) {
          if (!byId.has(incident.id)) byId.set(incident.id, incident);
        }
        if (!ctx.live()) return;
        state.incidents = [...byId.values()];
        state.incidentsHydrated = true;
      }
    }
    const derived = ctx.live() ? deriveProductHealthHistory(state.history, Date.now()).incidents : [];
    const reconciled = reconcileIncidents({
      persisted: state.incidents,
      derived,
      limit: PRODUCT_HEALTH_INCIDENT_MAX,
      currentProbeStatus: new Map(
        (state.history[state.history.length - 1]?.probes ?? []).map(
          (probe) => [probe.name, probe.status] as const,
        ),
      ),
    });
    const stuckClosed = closeOpenStuckTickIncidents(reconciled.merged, Date.now());
    // Memory closes even when the log write fails. The board reads this array.
    if (ctx.live()) state.incidents = stuckClosed.incidents;
    // post() itself refuses once this tick is no longer current.
    await ctx.post("appendIncidents", () => appendIncidentsFn(reconciled.writes), undefined);
    await ctx.post("appendStuckIncidents", () => appendIncidentsFn(stuckClosed.writes), undefined);
  } catch (error) {
    log.warn({ err: error }, "product_health_incident_log_skipped");
  }
  if (!ctx.live()) return;
  if (state.snapshot?.solvency) {
    const gasBurn = (() => {
      const gas = state.snapshot?.gas;
      if (!gas || "unreadable" in gas || "disabled" in gas || "inProgress" in gas) return undefined;
      const rate = measuredGasBurn({
        totalDot: gas.totalDot,
        blocksScanned: gas.blocksScanned,
        blockSeconds: state.snapshot?.flow?.payout?.window?.blockSeconds ?? null,
        truncated: gas.truncated,
        ageMs: gas.ageMs,
      });
      return isBurnUnmeasurable(rate) ? undefined : { signer_gas: rate };
    })();
    const runway = deriveLiquidityRunway(
      state.history,
      state.snapshot.solvency.pools,
      Date.now(),
      gasBurn ? { measuredBurn: gasBurn } : {},
    );
    if (!ctx.live()) return;
    state.snapshot.solvency.runwayNote = runway.note;
    state.snapshot.solvency.runway = runway.pools;
    const runwayDecision = decideRunwayAlert({
      runway,
      state: state.runwayAlertState,
      nowMs: Date.now(),
      cooldownMs: deps.cooldownMs,
    });
    if (!ctx.live()) return;
    state.runwayAlertState = runwayDecision.state;
    if (runwayDecision.alert) {
      await ctx.post(
        "runwayAlert",
        () => deps.alertChannel.dispatch(buildRunwayAlertPayload(runway, refreshBoardUrl)),
        false,
      );
      if (!ctx.live()) return;
    }
  }
  const opsNarrationNowMs = Date.now();
  const opsNarration = decideOpsNarration({
    prev: state.prevProductHealthStatus,
    curr: result.status as OpsStatus,
    probes: result.evaluation.probes,
    network: (env.WALLET_NETWORK ?? "").trim().toLowerCase() === "mainnet" ? "mainnet" : "testnet",
    muted: getServerAlertMuteUntilMs() > Date.now(),
    lastPostedAtMs: state.lastOpsNarrationPostedAtMs,
    nowMs: opsNarrationNowMs,
    cooldownMs: deps.cooldownMs,
    ...(state.opsNarrationRedAnnounced === undefined ? {} : { redAnnounced: state.opsNarrationRedAnnounced }),
  });
  if (!ctx.live()) return;
  state.prevProductHealthStatus = result.status as OpsStatus;
  state.opsNarrationRedAnnounced = opsNarration.redAnnounced;
  if (opsNarration.post && opsNarration.text) {
    try {
      if (!ctx.live()) return;
      recordCollaboration({ author: "hermes", text: opsNarration.text, kind: "chat" });
      state.lastOpsNarrationPostedAtMs = opsNarrationNowMs;
      log.info({ edge: opsNarration.edge }, "ops_narration_posted");
    } catch (err) {
      log.warn({ err }, "ops_narration_post_failed");
    }
    const buzz = buzzConfigOf(env);
    if (buzz.config) {
      const delivery = await ctx.post(
        "opsNarration",
        () => publish(buzz.config as BuzzConfig, opsNarration.text ?? ""),
        { ok: false, reason: "timeout", detail: "timed out after 20s" },
      );
      if (!ctx.live()) return;
      state.buzzDeliveryState = recordBuzzDelivery(state.buzzDeliveryState, {
        ok: delivery.ok,
        reason: delivery.reason,
        detail: delivery.detail,
        atMs: Date.now(),
      });
      if (delivery.ok) {
        log.info({ edge: opsNarration.edge, eventId: delivery.eventId }, "ops_narration_buzz_published");
      } else {
        log.warn(
          { edge: opsNarration.edge, reason: delivery.reason, detail: delivery.detail },
          "ops_narration_buzz_failed",
        );
      }
    } else if ("problem" in buzz && buzz.problem) {
      log.warn({ problem: buzz.problem }, "ops_narration_buzz_misconfigured");
    }
  } else if (opsNarration.suppressed) {
    log.info({ edge: opsNarration.edge, suppressed: opsNarration.suppressed }, "ops_narration_suppressed");
  }
  const transitions = transitionsOf({
    previous: state.prevProbes,
    current: result.evaluation.probes,
    posted: state.postedProbeKeys,
    muted: getServerAlertMuteUntilMs() > Date.now(),
    streaks: state.probeStreaks,
  });
  if (!ctx.live()) return;
  state.prevProbes = transitions.next;
  state.postedProbeKeys = transitions.keys;
  state.probeStreaks = transitions.streaks;
  if (transitions.alerts.length > 0) {
    const buzzForProbes = buzzConfigOf(env);
    let buzzTimedOut = false;
    for (const alert of transitions.alerts) {
      if (!ctx.live()) return;
      if (!buzzForProbes.config) {
        log.info({ probe: alert.probe, kind: alert.kind }, "probe_transition_undelivered");
        continue;
      }
      // One timed-out Buzz post is enough. Later alerts in this tick are not sent.
      if (buzzTimedOut) break;
      const delivery = await ctx.post(
        "probeTransition",
        () => publish(buzzForProbes.config as BuzzConfig, alert.text),
        { ok: false, reason: "timeout", detail: "timed out after 20s" },
      );
      if (!ctx.live()) return;
      if (delivery.reason === "timeout") buzzTimedOut = true;
      state.buzzDeliveryState = recordBuzzDelivery(state.buzzDeliveryState, {
        ok: delivery.ok,
        reason: delivery.reason,
        detail: delivery.detail,
        atMs: Date.now(),
      });
      if (delivery.ok) {
        log.info({ probe: alert.probe, kind: alert.kind, eventId: delivery.eventId }, "probe_transition_published");
      } else {
        log.warn(
          { probe: alert.probe, kind: alert.kind, reason: delivery.reason, detail: delivery.detail },
          "probe_transition_publish_failed",
        );
      }
    }
  }
  const morningDigestSchedule = deps.digestSchedule ?? readDigestSchedule(env);
  if (morningDigestSchedule.problem && !state.morningDigestProblemLogged) {
    if (ctx.live()) {
      state.morningDigestProblemLogged = true;
      log.warn({ problem: morningDigestSchedule.problem }, "morning_digest_misconfigured");
    }
  }
  const digestNowMs = Date.now();
  const digestCheck = digestDue({
    nowMs: digestNowMs,
    schedule: morningDigestSchedule,
    lastSentLocalDate: state.morningDigestSentLocalDate ?? deps.readDigestSent?.() ?? null,
  });
  if (digestCheck.due && !(getServerAlertMuteUntilMs() > digestNowMs)) {
    const digestVerdict = deriveOpsVerdict({
      enabled: deps.enabled !== false,
      checks: state.history.length,
      probes: result.evaluation.probes,
      pools: state.snapshot?.solvency?.pools ?? [],
      runway: state.snapshot?.solvency?.runway ?? [],
      ...(state.snapshot?.flow?.payout ? { payout: state.snapshot.flow.payout } : {}),
    });
    const queue = await ctx.post("readSocialQueue", () => readSocialQueueFn(), {
      state: "unreadable" as const,
      drafts: [],
      problem: "timed out after 20s",
    });
    const digestSocialSignal = await ctx.post("readSocialSignal", () => readSocialSignalFn(), {
      text: "public record timed out after 20s — no figures either way",
      tone: "degraded" as const,
    });
    if (!ctx.live()) return;
    const line = buildSocialQueueLine(queue);
    const digestSocialQueue = line ? { ...line, count: queue.drafts.length } : null;
    const digestInput = {
      localDate: digestCheck.localDate,
      localTime: digestCheck.localTime,
      weekday: digestCheck.weekday,
      humanDate: digestCheck.humanDate,
      timeZone: morningDigestSchedule.timeZone,
      network: (env.WALLET_NETWORK ?? "").trim().toLowerCase() === "mainnet" ? "mainnet" : "testnet",
      verdictHeadline: digestVerdict.headline,
      verdictReason: digestVerdict.reason,
      verdictTone: digestVerdict.tone,
      probes: result.evaluation.probes,
      bankRequests: state.snapshot?.bank?.lane?.requests ?? null,
      bankMoveLines: bankChangeText(state.snapshot?.bankMoves) ?? undefined,
      socialSignal: digestSocialSignal,
      socialQueue: digestSocialQueue,
    };
    const digestPlain = buildMorningDigest(digestInput);
    let digestText = digestPlain;
    const digestLlmKey = env.OLLAMA_API_KEY?.trim();
    if (digestLlmKey) {
      if (!ctx.live()) return;
      const composed = await ctx.post("composeDigest", () => composeConversationalDigest({
        plain: digestPlain,
        verdictHeadline: digestVerdict.headline,
        facts: digestFactStrings(digestInput),
        redCount: result.evaluation.probes.filter((probe) => probe.status === "red").length,
        attentionLabels: [
          ...result.evaluation.probes.filter((probe) => probe.status !== "ok").map((probe) => probeLabel(probe.name)),
          ...(digestInput.bankRequests && ["red", "degraded"].includes(digestInput.bankRequests.tone) ? ["Bank"] : []),
        ],
        request: (req) => requestCompletion(req, {
          apiKey: digestLlmKey,
          baseUrl: env.OLLAMA_BASE_URL?.trim() || "https://ollama.com/v1",
          timeoutMs: DIGEST_COMPLETION_TIMEOUT_MS,
        }),
      }), null);
      if (composed) {
        digestText = composed.text;
        log.info(
          { voice: composed.voice, ...(composed.reason ? { reason: composed.reason } : {}) },
          "morning_digest_voice",
        );
      } else {
        log.warn("morning_digest_voice_timed_out");
      }
    }
    const digestBuzz = buzzConfigOf(env);
    if (!ctx.live()) return;
    if (!digestBuzz.config) {
      recordCollaboration({ author: "hermes", text: digestText, kind: "chat" });
      state.morningDigestSentLocalDate = digestCheck.localDate;
      deps.writeDigestSent?.(digestCheck.localDate);
      log.info({ localDate: digestCheck.localDate }, "morning_digest_recorded_undelivered");
    } else {
      const delivery = await ctx.post(
        "digestPublish",
        () => publish(digestBuzz.config as BuzzConfig, digestText),
        { ok: false, reason: "timeout", detail: "timed out after 20s" },
      );
      if (!ctx.live()) return;
      state.buzzDeliveryState = recordBuzzDelivery(state.buzzDeliveryState, {
        ok: delivery.ok,
        reason: delivery.reason,
        detail: delivery.detail,
        atMs: Date.now(),
      });
      if (delivery.ok) {
        recordCollaboration({ author: "hermes", text: digestText, kind: "chat" });
        state.morningDigestSentLocalDate = digestCheck.localDate;
        deps.writeDigestSent?.(digestCheck.localDate);
        log.info({ localDate: digestCheck.localDate, eventId: delivery.eventId }, "morning_digest_published");
      } else {
        log.warn({ reason: delivery.reason, detail: delivery.detail }, "morning_digest_publish_failed");
      }
    }
  }
  if (result.status !== "healthy") {
    log.warn(
      { status: result.status, alerted: result.alerted, probes: result.evaluation.probes },
      "product_health_probe",
    );
  }
}

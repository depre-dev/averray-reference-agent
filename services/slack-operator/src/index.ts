import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { logger, optionalEnv, query } from "@avg/mcp-common";
import { createDefaultWorkflowDeps } from "@avg/averray-mcp/default-workflow-runtime";
import { invokeAgentTask } from "@avg/averray-mcp/agent-invocation";
import { getHandoffMonitor } from "@avg/averray-mcp/handoff-events";
import { handleOperatorCommandText } from "@avg/averray-mcp/operator-handler";
import {
  formatOperatorResultForSlack,
  isAuthorizedSlackCommand,
  parseCsvSet,
  textFromSlackEvent,
  textFromSlashCommand,
  verifySlackSignature,
  slackPermalinkFromParts,
  type SlackCommandEnvelope,
} from "./slack.js";
import { recordOperatorCommandEvent } from "./persistence.js";
import {
  parseSlackRoutineConfig,
  shouldPostSafeWorkResult,
  shouldRunDailyBrief,
  shouldRunDailyGithubBrief,
  shouldRunOpsHealth,
} from "./routines.js";
import {
  guardMonitorCommand,
  isMonitorAuthorized,
  parseMonitorConfig,
  renderMonitorHtml,
  renderMonitorManifest,
} from "./monitor.js";
import {
  CollaborationValidationError,
  classifyHermesMemoryRequest,
  listCollaborationMessages,
  listHermesMemoryNotes,
  recordCollaborationMessage,
  synthesizeHermesReplyFor,
} from "./monitor-collab.js";
import { buildHermesBoardSnapshotFromMonitor } from "./monitor-hermes-board.js";
import {
  decideHermesBoardNarration,
  fallbackHermesBoardNarration,
  relatedPrForHermesBoardNarration,
  targetForHermesBoardNarration,
} from "./monitor-hermes-narration.js";
import {
  appendHermesWhyTrace,
  applyHermesMemoryInfluence,
  generateHermesBoardNarration,
  generateHermesReply,
} from "./monitor-hermes-voice.js";
import {
  approveCodexTask,
  cancelCodexTask,
  listCodexTasks,
  proposeCodexTask,
  readCodexRunnerHeartbeat,
  summarizeCodexTasks,
} from "./codex-task-queue.js";
import {
  listTestbedMissionRuns,
  recordTestbedMissionReportFromMessage,
  recordTestbedMissionRunFromOperatorResult,
  type TestbedMissionRun,
} from "./monitor-testbed-missions.js";
import {
  formatStalePrAlertForSlack,
  shouldPostStalePrAlert,
  stalePrAlertItems,
} from "./stale-pr-alerts.js";
import { enrichMonitorWithGithubPrState } from "./github-pr-state.js";

const enabled = optionalEnv("SLACK_OPERATOR_ENABLED", "0") === "1";
const httpPort = Number.parseInt(optionalEnv("SLACK_OPERATOR_HTTP_PORT", "8790"), 10);
const signingSecret = optionalEnv("SLACK_SIGNING_SECRET");
const botToken = optionalEnv("SLACK_BOT_TOKEN");
const appToken = optionalEnv("SLACK_APP_TOKEN");
const allowedChannelIds = optionalEnv("SLACK_OPERATOR_CHANNEL_IDS") || optionalEnv("SLACK_OPERATOR_CHANNEL_ID");
const authConfig = {
  allowedChannelIds: parseCsvSet(allowedChannelIds),
  allowedUserIds: parseCsvSet(optionalEnv("SLACK_ALLOWED_USER_IDS")),
};
const routineConfig = parseSlackRoutineConfig(process.env, authConfig.allowedChannelIds);
const monitorConfig = parseMonitorConfig(process.env);
const monitorNarrationMinIntervalMs = Math.max(
  5_000,
  Number.parseInt(optionalEnv("HERMES_MONITOR_NARRATION_MIN_INTERVAL_MS", "30000"), 10) || 30_000
);
let lastHermesBoardNarrationSignature = "";
let inFlightHermesBoardNarrationSignature = "";
let lastHermesBoardNarrationAtMs = 0;

logger.info({
  enabled,
  httpPort,
  socketMode: Boolean(appToken),
  httpSigning: Boolean(signingSecret),
  botToken: Boolean(botToken),
  allowedChannels: authConfig.allowedChannelIds.size,
  allowedUsers: authConfig.allowedUserIds.size,
  routines: {
    channelConfigured: Boolean(routineConfig.channelId),
    dailyBrief: routineConfig.dailyBrief.enabled,
    dailyBriefIncludeGithub: routineConfig.dailyBrief.includeGithub,
    dailyBriefTimeUtc: `${String(routineConfig.dailyBrief.timeUtc.hour).padStart(2, "0")}:${String(routineConfig.dailyBrief.timeUtc.minute).padStart(2, "0")}`,
    dailyGithubBrief: routineConfig.dailyGithubBrief.enabled,
    dailyGithubBriefTimeUtc: `${String(routineConfig.dailyGithubBrief.timeUtc.hour).padStart(2, "0")}:${String(routineConfig.dailyGithubBrief.timeUtc.minute).padStart(2, "0")}`,
    opsHealth: routineConfig.opsHealth.enabled,
    opsHealthTimeUtc: `${String(routineConfig.opsHealth.timeUtc.hour).padStart(2, "0")}:${String(routineConfig.opsHealth.timeUtc.minute).padStart(2, "0")}`,
    safeWorkScanIntervalMs: routineConfig.safeWorkScan.enabled ? routineConfig.safeWorkScan.intervalMs : 0,
    stalePrAlertIntervalMs: routineConfig.stalePrAlerts.enabled ? routineConfig.stalePrAlerts.intervalMs : 0,
    stalePrAlertAfterMinutes: routineConfig.stalePrAlerts.staleAfterMinutes,
  },
  monitor: {
    enabled: monitorConfig.enabled,
    tokenProtected: Boolean(monitorConfig.token),
  },
}, "slack_operator_starting");

const server = http.createServer((request, response) => {
  void handleHttpRequest(request, response);
});
server.listen(httpPort, "0.0.0.0", () => {
  logger.info({ httpPort }, "slack_operator_http_listening");
});

if (!enabled) {
  logger.info("slack_operator_disabled");
} else {
  if (appToken) void runSocketModeForever();
  if (!appToken && !signingSecret) {
    logger.warn("slack_operator_enabled_without_socket_or_signing_secret");
  }
  startOperatorRoutines();
}

async function handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, {
      status: "ok",
      enabled,
      routines: {
        channelConfigured: Boolean(routineConfig.channelId),
        dailyBrief: {
          enabled: routineConfig.dailyBrief.enabled,
          timeUtc: formatUtcTime(routineConfig.dailyBrief.timeUtc),
          includeGithub: routineConfig.dailyBrief.includeGithub,
        },
        dailyGithubBrief: {
          enabled: routineConfig.dailyGithubBrief.enabled,
          timeUtc: formatUtcTime(routineConfig.dailyGithubBrief.timeUtc),
        },
        opsHealth: {
          enabled: routineConfig.opsHealth.enabled,
          timeUtc: formatUtcTime(routineConfig.opsHealth.timeUtc),
        },
        safeWorkScan: {
          enabled: routineConfig.safeWorkScan.enabled,
          intervalMs: routineConfig.safeWorkScan.enabled ? routineConfig.safeWorkScan.intervalMs : 0,
          notifyOnlyOnAvailable: routineConfig.safeWorkScan.notifyOnlyOnAvailable,
        },
        stalePrAlerts: {
          enabled: routineConfig.stalePrAlerts.enabled,
          intervalMs: routineConfig.stalePrAlerts.enabled ? routineConfig.stalePrAlerts.intervalMs : 0,
          staleAfterMinutes: routineConfig.stalePrAlerts.staleAfterMinutes,
        },
      },
      monitor: {
        enabled: monitorConfig.enabled,
        tokenProtected: Boolean(monitorConfig.token),
        paths: monitorConfig.enabled ? [
          "/monitor",
          "/monitor/events",
          "/monitor/stream",
          "/monitor/command",
          "/monitor/recheck",
          "/monitor/codex-tasks",
          "/monitor/collaboration",
          "/monitor/manifest.webmanifest",
        ] : [],
      },
    });
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/" && monitorConfig.enabled) {
    writeRedirect(response, "/monitor");
    return;
  }
  if (request.method === "GET" && (url.pathname === "/monitor" || url.pathname === "/monitor/events" || url.pathname === "/monitor/stream" || url.pathname === "/monitor/manifest.webmanifest")) {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    if (url.pathname === "/monitor") {
      writeHtml(response, 200, renderMonitorHtml());
      return;
    }
    if (url.pathname === "/monitor/manifest.webmanifest") {
      response.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=300",
      });
      response.end(renderMonitorManifest());
      return;
    }
    if (url.pathname === "/monitor/stream") {
      await writeMonitorStream(request, response, url);
      return;
    }
    writeJson(response, 200, await loadMonitorSnapshot(url));
    return;
  }
  if (request.method === "GET" && url.pathname === "/monitor/codex-tasks") {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    writeJson(response, 200, await loadCodexTaskQueueSummary());
    return;
  }
  if (request.method === "POST" && url.pathname === "/monitor/codex-tasks") {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    await handleMonitorCodexTaskRequest(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/monitor/recheck") {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    await handleMonitorRecheckRequest(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/monitor/command") {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    await handleMonitorCommandRequest(request, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/monitor/collaboration") {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    const sinceMs = parseOptionalInteger(url.searchParams.get("sinceMs"));
    const limit = parseOptionalInteger(url.searchParams.get("limit"));
    writeJson(response, 200, {
      messages: listCollaborationMessages({
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/monitor/collaboration") {
    if (!monitorConfig.enabled) {
      writeJson(response, 404, { error: "monitor_disabled" });
      return;
    }
    if (!isMonitorAuthorized(monitorConfig, request.headers, url)) {
      writeJson(response, 401, { error: "monitor_unauthorized" });
      return;
    }
    await handleMonitorCollaborationRequest(request, response);
    return;
  }
  if (!enabled) {
    writeJson(response, 503, { error: "slack_operator_disabled" });
    return;
  }
  if (request.method === "POST" && request.url === "/slack/commands") {
    const rawBody = await readBody(request);
    if (!verifyHttpSignature(request, rawBody)) {
      writeJson(response, 401, { error: "invalid_slack_signature" });
      return;
    }
    const envelope = textFromSlashCommand(rawBody);
    if (!isAuthorizedSlackCommand(envelope, authConfig)) {
      writeJson(response, 200, { response_type: "ephemeral", text: "Averray command rejected: user or channel is not allowed." });
      return;
    }
    writeJson(response, 200, { response_type: "ephemeral", text: "Averray command received. Working..." });
    void handleCommand(envelope);
    return;
  }
  if (request.method === "POST" && request.url === "/slack/events") {
    const rawBody = await readBody(request);
    if (!verifyHttpSignature(request, rawBody)) {
      writeJson(response, 401, { error: "invalid_slack_signature" });
      return;
    }
    const payload = JSON.parse(rawBody) as unknown;
    if (isRecord(payload) && payload.type === "url_verification" && typeof payload.challenge === "string") {
      writeJson(response, 200, { challenge: payload.challenge });
      return;
    }
    const envelope = isRecord(payload) ? textFromSlackEvent(payload.event, stringField(payload, "team_id")) : null;
    writeJson(response, 200, { ok: true });
    if (envelope && isAuthorizedSlackCommand(envelope, authConfig)) void handleCommand(envelope);
    return;
  }
  writeJson(response, 404, { error: "not_found" });
}

async function runSocketModeForever() {
  while (true) {
    try {
      const url = await openSocketModeUrl();
      await runSocketModeConnection(url);
    } catch (error) {
      logger.warn({ err: error }, "slack_socket_mode_error");
      await delay(5_000);
    }
  }
}

async function openSocketModeUrl(): Promise<string> {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
  });
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || payload.ok !== true || typeof payload.url !== "string") {
    throw new Error(`slack_apps_connections_open_failed:${JSON.stringify(payload)}`);
  }
  return payload.url;
}

async function runSocketModeConnection(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => logger.info("slack_socket_mode_connected"));
    socket.addEventListener("close", () => resolve());
    socket.addEventListener("error", () => reject(new Error("slack_socket_mode_websocket_error")));
    socket.addEventListener("message", (message) => {
      void handleSocketMessage(socket, String(message.data));
    });
  });
}

async function handleSocketMessage(socket: WebSocket, rawMessage: string) {
  const envelope = JSON.parse(rawMessage) as unknown;
  if (!isRecord(envelope)) return;
  const envelopeId = typeof envelope.envelope_id === "string" ? envelope.envelope_id : undefined;
  if (envelopeId) socket.send(JSON.stringify({ envelope_id: envelopeId }));

  if (envelope.type === "slash_commands") {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const command = stringField(payload, "command")?.replace(/^\//, "") ?? "";
    const text = stringField(payload, "text") || command;
    const commandEnvelope: SlackCommandEnvelope = {
      text,
      teamId: stringField(payload, "team_id"),
      userId: stringField(payload, "user_id"),
      channelId: stringField(payload, "channel_id"),
      responseUrl: stringField(payload, "response_url"),
    };
    if (isAuthorizedSlackCommand(commandEnvelope, authConfig)) void handleCommand(commandEnvelope);
    return;
  }

  if (envelope.type === "events_api") {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const commandEnvelope = textFromSlackEvent(payload.event, stringField(payload, "team_id"));
    if (commandEnvelope && isAuthorizedSlackCommand(commandEnvelope, authConfig)) void handleCommand(commandEnvelope);
  }
}

async function handleCommand(envelope: SlackCommandEnvelope) {
  try {
    logger.info({ text: envelope.text, userId: envelope.userId, channelId: envelope.channelId }, "slack_operator_command_received");
    const result = await handleOperatorCommandText(
      {
        text: envelope.text,
        source: "slack",
        defaultDryRun: false,
        maxEvidenceUrls: 5,
        confidenceThreshold: 0.7,
      },
      { query, workflowDeps: createDefaultWorkflowDeps() }
    );
    const replyPermalink = await postSlack(envelope, formatOperatorResultForSlack(result));
    await recordOperatorCommandEvent({
      source: "slack",
      commandText: envelope.text,
      teamId: envelope.teamId,
      userId: envelope.userId,
      channelId: envelope.channelId,
      slackPermalink: envelope.permalink,
      replyPermalink,
      result,
    }, query);
  } catch (error) {
    logger.error({ err: error }, "slack_operator_command_failed");
    await postSlack(envelope, `Averray command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Hermes-side auto-reply for operator posts. Operators need the
// channel to feel like a conversation — silence after a post reads as
// "the agents aren't listening".
//
// Voice routing:
//   1. If OLLAMA_API_KEY is configured, call Ollama Cloud with the
//      Hermes persona prompt + recent thread + selected-PR context.
//      The reply is a real LLM-generated sentence in Hermes's voice.
//   2. On any LLM failure (no key, timeout, HTTP error, malformed
//      response) fall back to the canned template from
//      synthesizeHermesReplyFor so the chat never silently breaks.
//
// Fire-and-forget: the LLM call runs after ~600ms so the operator's
// own bubble paints first, then Hermes's reply lands 2-5s later.
// timer.unref() so a slow LLM call can't keep the process alive on
// shutdown.
function scheduleHermesAutoReply(operatorMessage: Awaited<ReturnType<typeof recordCollaborationMessage>>) {
  const draft = synthesizeHermesReplyFor(operatorMessage);
  if (!draft) return;

  const apiKey = optionalEnv("OLLAMA_API_KEY");
  const baseUrl = optionalEnv("OLLAMA_BASE_URL") ?? "https://ollama.com/v1";
  const model = optionalEnv("HERMES_MONITOR_REPLY_MODEL") ?? "deepseek-v4-pro:cloud";

  const timer = setTimeout(async () => {
    let text = draft.text;
    const memoryNotes = listHermesMemoryNotes({
      ...(operatorMessage.relatedPr ? { relatedPr: operatorMessage.relatedPr } : {}),
      ...(operatorMessage.relatedCorrelationId ? { relatedCorrelationId: operatorMessage.relatedCorrelationId } : {}),
      limit: 8,
    }).map((note) => note.text);
    const shouldLoadBoard = Boolean(apiKey) || memoryNotes.length > 0;
    const board = shouldLoadBoard ? await loadHermesBoardSnapshotForReply(operatorMessage) : undefined;
    const replyContext = {
      operatorMessage: {
        text: operatorMessage.text,
        addressedTo: operatorMessage.addressedTo,
        kind: operatorMessage.kind,
        ...(operatorMessage.relatedPr ? { relatedPr: operatorMessage.relatedPr } : {}),
      },
      recentMessages: apiKey
        ? listCollaborationMessages({ limit: 10 }).map((m) => ({ author: m.author, text: m.text, ts: m.ts }))
        : [],
      memoryNotes,
      ...(operatorMessage.relatedPr ? { selectedPr: operatorMessage.relatedPr } : {}),
      ...(board ? { board } : {}),
    };
    const memoryRequest = classifyHermesMemoryRequest(operatorMessage);
    if (memoryRequest !== "none") {
      text = hermesMemoryGovernanceReply(operatorMessage, memoryRequest, memoryNotes);
    } else if (apiKey) {
      try {
        // replyContext carries the recent thread oldest-first so the
        // model sees the conversation in natural order rather than reversed.
        const llmText = await generateHermesReply(replyContext, { apiKey, baseUrl, model });
        if (llmText) {
          text = llmText;
        } else {
          logger.info({ id: operatorMessage.id }, "monitor_collaboration_llm_reply_unavailable_fell_back");
        }
      } catch (error) {
        logger.warn({ err: error, id: operatorMessage.id }, "monitor_collaboration_llm_reply_threw");
      }
    }
    if (memoryRequest !== "forget_pr") {
      text = appendHermesWhyTrace(applyHermesMemoryInfluence(text, replyContext), replyContext);
    }
    try {
      recordCollaborationMessage({
        author: "hermes",
        kind: "chat",
        text,
        addressedTo: draft.addressedTo,
        ...(draft.relatedPr ? { relatedPr: draft.relatedPr } : {}),
        ...(draft.relatedCorrelationId ? { relatedCorrelationId: draft.relatedCorrelationId } : {}),
      });
    } catch (error) {
      logger.warn({ err: error }, "monitor_collaboration_auto_reply_failed");
    }
  }, 600);
  timer.unref?.();
}

function hermesMemoryGovernanceReply(
  operatorMessage: Awaited<ReturnType<typeof recordCollaborationMessage>>,
  request: ReturnType<typeof classifyHermesMemoryRequest>,
  memoryNotes: string[]
): string {
  const prLabel = operatorMessage.relatedPr
    ? `${operatorMessage.relatedPr.repo}#${operatorMessage.relatedPr.number}`
    : "";
  if (request === "forget_pr") {
    if (!operatorMessage.relatedPr) {
      return "I can forget PR-scoped memory, but I need a selected PR first. Pick the card, then say `Hermes, forget this PR memory` and I will clear only that PR's notes.";
    }
    return `Done. I cleared any PR-scoped memory I had for ${prLabel}; global Pascal preferences are still intact. If this PR needs a replacement rule, tell me with \`remember:\` and I will learn the corrected version.`;
  }

  if (!memoryNotes.length) {
    return prLabel
      ? `I do not have any remembered guidance for ${prLabel} yet. I will use the live board as the source of truth and learn from your next explicit correction or decision.`
      : "I do not have any global monitor memory yet. I will learn from explicit `remember:` notes and operator decisions as they happen.";
  }

  const scope = prLabel ? `for ${prLabel}` : "for the monitor";
  const bullets = memoryNotes.slice(0, 4).map((note) => `- ${shortMemoryNote(note)}`).join("\n");
  return `Here is what I remember ${scope}. I will treat this as guidance, not proof; the live board still wins if it disagrees.\n${bullets}`;
}

function shortMemoryNote(note: string): string {
  const compact = note
    .replace(/^Pascal (?:preference|note|outcome)(?: for [^:]+)?:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

async function loadHermesBoardSnapshotForReply(
  operatorMessage: Awaited<ReturnType<typeof recordCollaborationMessage>>
) {
  try {
    const url = new URL("http://localhost/monitor/events?limit=40&activeWindowMinutes=240");
    const snapshot = await withTimeout(
      loadMonitorSnapshot(url, { suppressNarration: true }),
      4_000,
      "monitor_reply_board_snapshot_timeout"
    );
    return buildHermesBoardSnapshotFromMonitor(snapshot);
  } catch (error) {
    logger.warn({ err: error, id: operatorMessage.id }, "monitor_collaboration_board_snapshot_unavailable");
    return undefined;
  }
}

async function handleMonitorCollaborationRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  try {
    const rawBody = await readBody(request);
    const payload = rawBody ? JSON.parse(rawBody) as unknown : {};
    if (!isRecord(payload)) {
      writeJson(response, 400, { error: "invalid_payload" });
      return;
    }
    const message = recordCollaborationMessage(payload);
    const testbedMissionRun = recordTestbedMissionReportFromMessage({
      relatedCorrelationId: message.relatedCorrelationId,
      text: message.text,
    });
    if (testbedMissionRun) {
      recordTestbedMissionReportCollaboration(testbedMissionRun);
    }
    logger.info(
      {
        author: message.author,
        kind: message.kind,
        addressedTo: message.addressedTo,
        id: message.id,
        testbedMissionRunId: testbedMissionRun?.id,
      },
      "monitor_collaboration_message_recorded"
    );
    scheduleHermesAutoReply(message);
    writeJson(response, 200, { ok: true, message, ...(testbedMissionRun ? { testbedMissionRun } : {}) });
  } catch (error) {
    if (error instanceof CollaborationValidationError) {
      writeJson(response, 400, { error: error.code, message: error.message });
      return;
    }
    logger.error({ err: error }, "monitor_collaboration_record_failed");
    writeJson(response, 500, {
      error: "monitor_collaboration_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordTestbedMissionReportCollaboration(run: TestbedMissionRun): void {
  try {
    const verdict = typeof run.result?.verdict === "string" ? run.result.verdict : run.status;
    recordCollaborationMessage({
      author: "hermes",
      kind: "status",
      addressedTo: run.status === "completed" ? "everyone" : "operator",
      relatedCorrelationId: run.id,
      text: run.status === "completed"
        ? [
          `I ingested the browser-agent report for ${run.id}.`,
          `Verdict is ${verdict}; the mission is complete and the board now has structured evidence attached.`,
          "Use the report in the drawer as the testbed proof for the next product improvement.",
        ].join(" ")
        : [
          `I ingested the browser-agent report for ${run.id}.`,
          `Verdict is ${verdict}; I am keeping the mission visible because the report needs follow-up.`,
          "Open the card to inspect blockers, scores, and evidence before changing the page or mission prompt.",
        ].join(" "),
    });
  } catch (error) {
    logger.warn({ err: error, missionId: run.id }, "monitor_testbed_mission_report_collaboration_failed");
  }
}

async function handleMonitorCommandRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  try {
    const rawBody = await readBody(request);
    const payload = rawBody ? JSON.parse(rawBody) as unknown : {};
    const text = isRecord(payload) && typeof payload.text === "string" ? payload.text.trim() : "";
    const guard = guardMonitorCommand(text);
    if (!guard.allowed) {
      writeJson(response, 400, {
        error: guard.reason ?? "command_blocked",
        message: "This monitor console only runs read-only status/proposal commands. Use Slack or the MCP operator tools for explicit admin mutations.",
        normalizedText: guard.normalizedText,
      });
      return;
    }
    logger.info({ text, normalizedText: guard.normalizedText }, "monitor_operator_command_received");
    const result = await handleOperatorCommandText(
      {
        text,
        source: "command_center",
        defaultDryRun: true,
        maxEvidenceUrls: 5,
        confidenceThreshold: 0.7,
      },
      { query, workflowDeps: createDefaultWorkflowDeps() }
    );
    await recordOperatorCommandEvent({
      source: "monitor",
      commandText: text,
      result,
    }, query).catch((error) => logger.warn({ err: error }, "monitor_operator_command_record_failed"));
    const testbedMissionRun = recordTestbedMissionRunFromOperatorResult(result);
    if (testbedMissionRun) {
      recordTestbedMissionCollaboration(testbedMissionRun);
    }
    writeJson(response, 200, {
      ok: true,
      text: formatOperatorResultForSlack(result),
      result,
      ...(testbedMissionRun ? { testbedMissionRun } : {}),
    });
  } catch (error) {
    logger.error({ err: error }, "monitor_operator_command_failed");
    writeJson(response, 500, {
      error: "monitor_command_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordTestbedMissionCollaboration(run: TestbedMissionRun): void {
  try {
    recordCollaborationMessage({
      author: "hermes",
      kind: "status",
      addressedTo: "operator",
      relatedCorrelationId: run.id,
      text: [
        `I created a fresh-agent browser mission for ${run.targetUrl}.`,
        `The mission is now on the board as ${run.id}; open its card to copy the browser-only prompt and report schema.`,
        "Start it with a clean browser-capable agent, then paste the structured report back here so I can compare the evidence and keep improving the testbed.",
      ].join(" "),
    });
  } catch (error) {
    logger.warn({ err: error, missionId: run.id }, "monitor_testbed_mission_collaboration_failed");
  }
}

async function handleMonitorRecheckRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  try {
    const rawBody = await readBody(request);
    const payload = rawBody ? JSON.parse(rawBody) as unknown : {};
    if (!isRecord(payload)) {
      writeJson(response, 400, { error: "invalid_payload" });
      return;
    }

    const repo = stringField(payload, "repo");
    const pullRequestNumber = numberField(payload, "pullRequestNumber");
    if (!repo || typeof pullRequestNumber !== "number" || pullRequestNumber < 1) {
      writeJson(response, 400, {
        error: "invalid_recheck_request",
        message: "repo and pullRequestNumber are required to ask Hermes for a PR re-check.",
      });
      return;
    }

    const correlationId = stringField(payload, "correlationId")
      ?? `monitor-recheck-${repo.replace(/[^a-zA-Z0-9]+/g, "-")}-${pullRequestNumber}-${Date.now()}`;
    const reason = stringField(payload, "reason") ?? "monitor requested Hermes re-check after Codex handoff";
    const deps = {
      query,
      workflowDeps: createDefaultWorkflowDeps(),
      githubEnv: {
        ...process.env,
        // Monitor-triggered re-checks are private/read-only. The GitHub Actions
        // handoff remains the path that may update PR comments.
        GITHUB_PR_HANDOFF_COMMENTS_ENABLED: "0",
      },
    };
    const base = {
      requester: "command-center",
      repo,
      pullRequestNumber,
      correlationId,
      reason,
    };
    const codeReview = await invokeAgentTask({ ...base, intent: "pr_code_review" }, deps);
    const handoff = await invokeAgentTask({
      ...base,
      intent: "pr_handoff",
      testCaseIds: ["TBE2E-004"],
    }, deps);
    writeJson(response, 200, {
      ok: true,
      text: `Hermes re-check completed for ${repo}#${pullRequestNumber}.`,
      codeReview,
      handoff,
      monitor: await loadMonitorSnapshot(new URL("http://localhost/monitor/events?limit=50&activeWindowMinutes=240")),
    });
  } catch (error) {
    logger.error({ err: error }, "monitor_recheck_failed");
    writeJson(response, 500, {
      error: "monitor_recheck_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleMonitorCodexTaskRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  try {
    const rawBody = await readBody(request);
    const payload = rawBody ? JSON.parse(rawBody) as unknown : {};
    if (!isRecord(payload)) {
      writeJson(response, 400, { error: "invalid_payload" });
      return;
    }
    const action = stringField(payload, "action") ?? "propose";
    if (action === "propose") {
      const repo = stringField(payload, "repo");
      const pullRequestNumber = numberField(payload, "pullRequestNumber");
      const prompt = stringField(payload, "prompt");
      if (!repo || typeof pullRequestNumber !== "number" || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1 || !prompt) {
        writeJson(response, 400, {
          error: "invalid_codex_task",
          message: "repo, pullRequestNumber, and prompt are required to propose Codex work.",
        });
        return;
      }
      const result = await proposeCodexTask({
        repo,
        pullRequestNumber,
        prompt,
        ...(stringField(payload, "correlationId") ? { correlationId: stringField(payload, "correlationId") } : {}),
        ...(stringField(payload, "title") ? { title: stringField(payload, "title") } : {}),
        ...(stringField(payload, "reason") ? { reason: stringField(payload, "reason") } : {}),
        requester: stringField(payload, "requester") ?? "monitor",
      });
      writeJson(response, 200, {
        ok: true,
        action,
        created: result.created,
        task: result.task,
        queue: await loadCodexTaskQueueSummary(),
      });
      return;
    }

    if (action === "approve") {
      const id = stringField(payload, "id");
      if (!id) {
        writeJson(response, 400, { error: "missing_task_id" });
        return;
      }
      const task = await approveCodexTask(id, { approvedBy: "operator" });
      if (!task) {
        writeJson(response, 404, { error: "codex_task_not_found" });
        return;
      }
      writeJson(response, 200, {
        ok: true,
        action,
        task,
        queue: await loadCodexTaskQueueSummary(),
      });
      return;
    }

    if (action === "cancel") {
      const id = stringField(payload, "id");
      if (!id) {
        writeJson(response, 400, { error: "missing_task_id" });
        return;
      }
      const task = await cancelCodexTask(id, { cancelledBy: "operator" });
      if (!task) {
        writeJson(response, 404, { error: "codex_task_not_found" });
        return;
      }
      writeJson(response, 200, {
        ok: true,
        action,
        task,
        queue: await loadCodexTaskQueueSummary(),
      });
      return;
    }

    writeJson(response, 400, { error: "unsupported_codex_task_action", action });
  } catch (error) {
    logger.error({ err: error }, "monitor_codex_task_failed");
    writeJson(response, 500, {
      error: "monitor_codex_task_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function startOperatorRoutines() {
  if (!routineConfig.channelId) {
    if (
      routineConfig.dailyBrief.enabled
      || routineConfig.dailyGithubBrief.enabled
      || routineConfig.opsHealth.enabled
      || routineConfig.safeWorkScan.enabled
      || routineConfig.stalePrAlerts.enabled
    ) {
      logger.warn("slack_operator_routines_no_channel");
    }
    return;
  }

  let lastDailyBriefDateKey: string | undefined;
  let lastDailyGithubBriefDateKey: string | undefined;
  let lastOpsHealthDateKey: string | undefined;
  let lastSafeWorkSignature: string | undefined;
  let lastStalePrSignature: string | undefined;
  let dailyBriefRunning = false;
  let dailyGithubBriefRunning = false;
  let opsHealthRunning = false;
  let safeWorkRunning = false;
  let stalePrAlertsRunning = false;

  const checkDailyBrief = async () => {
    if (dailyBriefRunning) return;
    const decision = shouldRunDailyBrief(new Date(), routineConfig, lastDailyBriefDateKey);
    if (!decision.shouldRun) return;
    dailyBriefRunning = true;
    try {
      if (await routineAlreadyRecordedToday("daily operator brief", decision.dateKey)) {
        lastDailyBriefDateKey = decision.dateKey;
        return;
      }
      const commandTexts = routineConfig.dailyBrief.includeGithub
        ? ["daily operator brief", "daily github brief"]
        : ["daily operator brief"];
      await runRoutineCommands(commandTexts, "slack_operator_daily_brief_posted");
      lastDailyBriefDateKey = decision.dateKey;
    } catch (error) {
      logger.error({ err: error }, "slack_operator_daily_brief_failed");
    } finally {
      dailyBriefRunning = false;
    }
  };

  const checkDailyGithubBrief = async () => {
    if (dailyGithubBriefRunning) return;
    const decision = shouldRunDailyGithubBrief(new Date(), routineConfig, lastDailyGithubBriefDateKey);
    if (!decision.shouldRun) return;
    dailyGithubBriefRunning = true;
    try {
      if (await routineAlreadyRecordedToday("daily github brief", decision.dateKey)) {
        lastDailyGithubBriefDateKey = decision.dateKey;
        return;
      }
      await runRoutineCommand("daily github brief", "slack_operator_daily_github_brief_posted");
      lastDailyGithubBriefDateKey = decision.dateKey;
    } catch (error) {
      logger.error({ err: error }, "slack_operator_daily_github_brief_failed");
    } finally {
      dailyGithubBriefRunning = false;
    }
  };

  const checkOpsHealth = async () => {
    if (opsHealthRunning) return;
    const decision = shouldRunOpsHealth(new Date(), routineConfig, lastOpsHealthDateKey);
    if (!decision.shouldRun) return;
    opsHealthRunning = true;
    try {
      if (await routineAlreadyRecordedToday("ops health", decision.dateKey)) {
        lastOpsHealthDateKey = decision.dateKey;
        return;
      }
      await runRoutineCommand("ops health", "slack_operator_ops_health_posted");
      lastOpsHealthDateKey = decision.dateKey;
    } catch (error) {
      logger.error({ err: error }, "slack_operator_ops_health_failed");
    } finally {
      opsHealthRunning = false;
    }
  };

  const checkSafeWork = async () => {
    if (safeWorkRunning || !routineConfig.safeWorkScan.enabled) return;
    safeWorkRunning = true;
    try {
      const result = await executeOperatorText("find safe work");
      const decision = shouldPostSafeWorkResult(
        result,
        lastSafeWorkSignature,
        routineConfig.safeWorkScan.notifyOnlyOnAvailable
      );
      if (!decision.shouldPost) return;
      const replyPermalink = await postSlack(routineEnvelope("find safe work"), formatOperatorResultForSlack(result));
      await recordOperatorCommandEvent({
        source: "slack_routine",
        commandText: "find safe work",
        channelId: routineConfig.channelId,
        replyPermalink,
        result,
      }, query);
      lastSafeWorkSignature = decision.signature;
      logger.info({ signature: decision.signature }, "slack_operator_safe_work_posted");
    } catch (error) {
      logger.error({ err: error }, "slack_operator_safe_work_failed");
    } finally {
      safeWorkRunning = false;
    }
  };

  const checkStalePrAlerts = async () => {
    if (stalePrAlertsRunning || !routineConfig.stalePrAlerts.enabled) return;
    stalePrAlertsRunning = true;
    try {
      const monitor = await getHandoffMonitor({ limit: 100, activeWindowMinutes: 24 * 60 });
      const items = stalePrAlertItems({
        monitor,
        staleAfterMinutes: routineConfig.stalePrAlerts.staleAfterMinutes,
      });
      const decision = shouldPostStalePrAlert(items, lastStalePrSignature);
      if (!decision.shouldPost) return;
      const text = formatStalePrAlertForSlack(items, optionalEnv("SLACK_OPERATOR_MONITOR_URL", "https://monitor.averray.com/monitor"));
      const replyPermalink = await postSlack(routineEnvelope("stale PR handoff alert"), text);
      const result = {
        kind: "stale_pr_handoff_alert",
        staleCount: items.length,
        staleAfterMinutes: routineConfig.stalePrAlerts.staleAfterMinutes,
        items,
        safety: {
          readOnly: true,
          mutatesGithub: false,
          mutatesAverray: false,
          editsWikipedia: false,
        },
      };
      await recordOperatorCommandEvent({
        source: "slack_routine",
        commandText: "stale PR handoff alert",
        channelId: routineConfig.channelId,
        replyPermalink,
        result,
      }, query);
      lastStalePrSignature = decision.signature;
      logger.info({ staleCount: items.length, signature: decision.signature }, "slack_operator_stale_pr_alert_posted");
    } catch (error) {
      logger.error({ err: error }, "slack_operator_stale_pr_alert_failed");
    } finally {
      stalePrAlertsRunning = false;
    }
  };

  if (routineConfig.dailyBrief.enabled) {
    setTimeout(() => void checkDailyBrief(), 5_000);
    setInterval(() => void checkDailyBrief(), 60_000);
  }
  if (routineConfig.dailyGithubBrief.enabled) {
    setTimeout(() => void checkDailyGithubBrief(), 7_500);
    setInterval(() => void checkDailyGithubBrief(), 60_000);
  }
  if (routineConfig.opsHealth.enabled) {
    setTimeout(() => void checkOpsHealth(), 7_000);
    setInterval(() => void checkOpsHealth(), 60_000);
  }
  if (routineConfig.safeWorkScan.enabled) {
    setTimeout(() => void checkSafeWork(), 10_000);
    setInterval(() => void checkSafeWork(), routineConfig.safeWorkScan.intervalMs);
  }
  if (routineConfig.stalePrAlerts.enabled) {
    setTimeout(() => void checkStalePrAlerts(), 12_000);
    setInterval(() => void checkStalePrAlerts(), routineConfig.stalePrAlerts.intervalMs);
  }
}

async function runRoutineCommand(text: string, successLog: string) {
  await runRoutineCommands([text], successLog);
}

async function runRoutineCommands(commandTexts: string[], successLog: string) {
  const envelope = routineEnvelope(commandTexts.join(" + "));
  const results: Array<{ text: string; result: Awaited<ReturnType<typeof executeOperatorText>> }> = [];
  for (const text of commandTexts) {
    results.push({ text, result: await executeOperatorText(text) });
  }
  const replyPermalink = await postSlack(
    envelope,
    results.map(({ result }) => formatOperatorResultForSlack(result)).join("\n\n---\n\n")
  );
  for (const { text, result } of results) {
    await recordOperatorCommandEvent({
      source: "slack_routine",
      commandText: text,
      channelId: envelope.channelId,
      replyPermalink,
      result,
    }, query);
  }
  logger.info({ text: commandTexts.join(" + "), replyPermalink }, successLog);
}

function executeOperatorText(text: string) {
  return handleOperatorCommandText(
    {
      text,
      source: "slack",
      defaultDryRun: false,
      maxEvidenceUrls: 5,
      confidenceThreshold: 0.7,
    },
    { query, workflowDeps: createDefaultWorkflowDeps() }
  );
}

function routineEnvelope(text: string): SlackCommandEnvelope {
  return routineConfig.channelId ? { text, channelId: routineConfig.channelId } : { text };
}

async function routineAlreadyRecordedToday(commandText: string, dateKey: string): Promise<boolean> {
  const start = `${dateKey}T00:00:00.000Z`;
  const end = `${dateKey}T23:59:59.999Z`;
  try {
    const rows = await query<{ count?: string | number }>(
      `select count(*)::int as count
       from operator_command_events
       where source = 'slack_routine'
         and normalized_text = $1
         and updated_at >= $2::timestamptz
         and updated_at <= $3::timestamptz`,
      [commandText, start, end]
    );
    return Number(rows[0]?.count ?? 0) > 0;
  } catch (error) {
    logger.warn({ err: error }, "slack_operator_routine_dedupe_failed");
    return false;
  }
}

async function postSlack(envelope: SlackCommandEnvelope, text: string): Promise<string | undefined> {
  if (envelope.responseUrl) {
    await fetch(envelope.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text }),
    }).catch((error) => logger.warn({ err: error }, "slack_response_url_failed"));
    return envelope.permalink;
  }
  if (!botToken || !envelope.channelId) {
    logger.warn({ hasBotToken: Boolean(botToken), channelId: envelope.channelId }, "slack_operator_no_reply_route");
    return;
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel: envelope.channelId, text }),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    logger.warn({ status: response.status, payload }, "slack_chat_post_failed");
    return envelope.permalink;
  }
  return slackPermalinkFromParts(
    envelope.teamId,
    stringField(payload, "channel") ?? envelope.channelId,
    stringField(payload, "ts")
  ) ?? envelope.permalink;
}

function verifyHttpSignature(request: http.IncomingMessage, rawBody: string): boolean {
  return verifySlackSignature({
    signingSecret,
    timestamp: headerValue(request.headers["x-slack-request-timestamp"]),
    signature: headerValue(request.headers["x-slack-signature"]),
    rawBody,
  });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: http.ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function writeHtml(response: http.ServerResponse, status: number, html: string) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function writeRedirect(response: http.ServerResponse, location: string) {
  response.writeHead(302, { location });
  response.end();
}

async function loadMonitorSnapshot(
  url: URL,
  options: { suppressNarration?: boolean } = {}
): Promise<unknown> {
  const startedAt = Date.now();
  const phases: Array<Record<string, unknown>> = [];
  const handoffStartedAt = Date.now();
  const monitor = await getHandoffMonitor({
    correlationId: url.searchParams.get("correlationId") ?? undefined,
    limit: parseOptionalInteger(url.searchParams.get("limit")),
    activeWindowMinutes: parseOptionalInteger(url.searchParams.get("activeWindowMinutes")),
  });
  phases.push({
    name: "handoff_events",
    status: "ok",
    durationMs: Date.now() - handoffStartedAt,
  });
  let enriched = monitor;
  const githubTimeoutMs = monitorGithubEnrichTimeoutMs();
  const githubStartedAt = Date.now();
  try {
    enriched = await withTimeout(
      enrichMonitorWithGithubPrState(monitor),
      githubTimeoutMs,
      "monitor_github_enrichment_timeout"
    );
    phases.push({
      name: "github_pr_enrichment",
      status: "ok",
      durationMs: Date.now() - githubStartedAt,
      timeoutMs: githubTimeoutMs,
    });
  } catch (error) {
    logger.warn({ err: error }, "monitor_github_enrichment_skipped");
    phases.push({
      name: "github_pr_enrichment",
      status: "skipped",
      durationMs: Date.now() - githubStartedAt,
      timeoutMs: githubTimeoutMs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const codexStartedAt = Date.now();
  let codexTasks: Awaited<ReturnType<typeof loadCodexTaskQueueSummary>> | undefined;
  try {
    codexTasks = await loadCodexTaskQueueSummary();
    phases.push({
      name: "codex_task_queue",
      status: "ok",
      durationMs: Date.now() - codexStartedAt,
    });
  } catch (error) {
    logger.warn({ err: error }, "monitor_codex_task_queue_skipped");
    phases.push({
      name: "codex_task_queue",
      status: "skipped",
      durationMs: Date.now() - codexStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const degraded = phases.some((phase) => phase.status !== "ok");
  const diagnostics = {
    monitorSnapshot: {
      status: degraded ? "degraded" : "ok",
      durationMs: Date.now() - startedAt,
      phases,
    },
  };
  if (degraded) {
    logger.warn({ diagnostics }, "monitor_snapshot_degraded");
  }
  const snapshot = {
    ...enriched,
    codexTasks,
    testbedMissions: listTestbedMissionRuns({ limit: 20 }),
    collaborationMessages: listCollaborationMessages({ limit: 200 }),
    diagnostics,
  };
  if (!options.suppressNarration) {
    scheduleHermesBoardNarration(snapshot);
  }
  return snapshot;
}

function scheduleHermesBoardNarration(snapshot: unknown): void {
  const board = buildHermesBoardSnapshotFromMonitor(snapshot);
  const decision = decideHermesBoardNarration(
    board,
    lastHermesBoardNarrationSignature,
    inFlightHermesBoardNarrationSignature
  );
  if (!decision.shouldNarrate || !board) return;
  const now = Date.now();
  if (lastHermesBoardNarrationAtMs > 0 && now - lastHermesBoardNarrationAtMs < monitorNarrationMinIntervalMs) {
    logger.info(
      { reason: "min_interval", signature: decision.signature },
      "monitor_collaboration_board_narration_skipped"
    );
    return;
  }

  inFlightHermesBoardNarrationSignature = decision.signature;
  const timer = setTimeout(async () => {
    const memoryNotes = hermesMemoryNotesForBoard(board, 8);
    const narrationContext = {
      board,
      recentMessages: listCollaborationMessages({ limit: 8 }).map((m) => ({
        author: m.author,
        text: m.text,
        ts: m.ts,
      })),
      memoryNotes,
      trigger: decision.signature,
    };
    let text = appendHermesWhyTrace(
      fallbackHermesBoardNarration(board, { memoryNotes }),
      narrationContext
    );
    const apiKey = optionalEnv("OLLAMA_API_KEY");
    const baseUrl = optionalEnv("OLLAMA_BASE_URL") ?? "https://ollama.com/v1";
    const model = optionalEnv("HERMES_MONITOR_REPLY_MODEL") ?? "deepseek-v4-pro:cloud";
    if (apiKey) {
      try {
        const llmText = await generateHermesBoardNarration(narrationContext, { apiKey, baseUrl, model, timeoutMs: 6_000 });
        if (llmText) text = llmText;
      } catch (error) {
        logger.warn({ err: error }, "monitor_collaboration_board_narration_llm_threw");
      }
    }

    try {
      const relatedPr = relatedPrForHermesBoardNarration(board);
      recordCollaborationMessage({
        author: "hermes",
        kind: "status",
        addressedTo: targetForHermesBoardNarration(board),
        text,
        ...(relatedPr ? { relatedPr } : {}),
      });
      lastHermesBoardNarrationSignature = decision.signature;
      lastHermesBoardNarrationAtMs = Date.now();
    } catch (error) {
      logger.warn({ err: error }, "monitor_collaboration_board_narration_record_failed");
    } finally {
      if (inFlightHermesBoardNarrationSignature === decision.signature) {
        inFlightHermesBoardNarrationSignature = "";
      }
    }
  }, 900);
  timer.unref?.();
}

function hermesMemoryNotesForBoard(board: ReturnType<typeof buildHermesBoardSnapshotFromMonitor>, limit: number): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  const addNotes = (nextNotes: string[]) => {
    for (const note of nextNotes) {
      const key = note.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      notes.push(note);
      if (notes.length >= limit) return;
    }
  };

  for (const item of board?.items?.slice(0, 6) ?? []) {
    if (notes.length >= limit) break;
    if (!item.repo || !item.number) continue;
    addNotes(listHermesMemoryNotes({
      relatedPr: { repo: item.repo, number: item.number },
      limit: 4,
    }).map((note) => note.text));
  }

  if (notes.length < limit) {
    addNotes(listHermesMemoryNotes({ limit }).map((note) => note.text));
  }
  return notes;
}

async function loadCodexTaskQueueSummary() {
  const codexTasks = await listCodexTasks();
  const codexRunner = await readCodexRunnerHeartbeat().catch(() => undefined);
  return summarizeCodexTasks(codexTasks, 100, { runner: codexRunner });
}

function monitorGithubEnrichTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.GITHUB_MONITOR_ENRICH_TIMEOUT_MS ?? "2500", 10);
  if (!Number.isFinite(parsed)) return 2_500;
  return Math.max(250, Math.min(15_000, parsed));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function writeMonitorStream(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL
): Promise<void> {
  const intervalMs = Math.max(1_000, parseOptionalInteger(url.searchParams.get("intervalMs")) ?? 5_000);
  let closed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(`retry: ${intervalMs}\n\n`);

  const send = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      writeSseEvent(response, "monitor", await loadMonitorSnapshot(url));
    } catch (error) {
      writeSseEvent(response, "error", {
        error: "monitor_snapshot_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  request.on("close", () => {
    closed = true;
    if (timer) clearInterval(timer);
  });

  await send();
  if (!closed) timer = setInterval(() => void send(), intervalMs);
}

function writeSseEvent(response: http.ServerResponse, event: string, payload: unknown) {
  const data = JSON.stringify(payload)
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n");
  response.write(`event: ${event}\n${data}\n\n`);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field === "string" && field.trim().length > 0) {
    const parsed = Number.parseInt(field, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatUtcTime(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

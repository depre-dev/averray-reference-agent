import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { logger, optionalEnv, query } from "@avg/mcp-common";
import { createDefaultWorkflowDeps } from "@avg/averray-mcp/default-workflow-runtime";
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
} from "./routines.js";

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
    dailyBriefTimeUtc: `${String(routineConfig.dailyBrief.timeUtc.hour).padStart(2, "0")}:${String(routineConfig.dailyBrief.timeUtc.minute).padStart(2, "0")}`,
    safeWorkScanIntervalMs: routineConfig.safeWorkScan.enabled ? routineConfig.safeWorkScan.intervalMs : 0,
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
    writeJson(response, 200, { status: "ok", enabled });
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

function startOperatorRoutines() {
  if (!routineConfig.channelId) {
    if (routineConfig.dailyBrief.enabled || routineConfig.safeWorkScan.enabled) {
      logger.warn("slack_operator_routines_no_channel");
    }
    return;
  }

  let lastDailyBriefDateKey: string | undefined;
  let lastSafeWorkSignature: string | undefined;
  let dailyBriefRunning = false;
  let safeWorkRunning = false;

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
      await runRoutineCommand("daily operator brief", "slack_operator_daily_brief_posted");
      lastDailyBriefDateKey = decision.dateKey;
    } catch (error) {
      logger.error({ err: error }, "slack_operator_daily_brief_failed");
    } finally {
      dailyBriefRunning = false;
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

  if (routineConfig.dailyBrief.enabled) {
    setTimeout(() => void checkDailyBrief(), 5_000);
    setInterval(() => void checkDailyBrief(), 60_000);
  }
  if (routineConfig.safeWorkScan.enabled) {
    setTimeout(() => void checkSafeWork(), 10_000);
    setInterval(() => void checkSafeWork(), routineConfig.safeWorkScan.intervalMs);
  }
}

async function runRoutineCommand(text: string, successLog: string) {
  const envelope = routineEnvelope(text);
  const result = await executeOperatorText(text);
  const replyPermalink = await postSlack(envelope, formatOperatorResultForSlack(result));
  await recordOperatorCommandEvent({
    source: "slack_routine",
    commandText: text,
    channelId: envelope.channelId,
    replyPermalink,
    result,
  }, query);
  logger.info({ text, replyPermalink }, successLog);
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

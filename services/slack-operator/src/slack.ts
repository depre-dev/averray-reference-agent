import { createHmac, timingSafeEqual } from "node:crypto";

export interface SlackAuthConfig {
  allowedChannelIds: Set<string>;
  allowedUserIds: Set<string>;
}

export interface SlackCommandEnvelope {
  text: string;
  teamId?: string;
  userId?: string;
  channelId?: string;
  responseUrl?: string;
  permalink?: string;
}

export function parseCsvSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs?: number;
}): boolean {
  if (!input.signingSecret || !input.timestamp || !input.signature) return false;
  const timestampSeconds = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 60 * 5) return false;

  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(base).digest("hex")}`;
  return timingSafeStringEqual(expected, input.signature);
}

export function isAuthorizedSlackCommand(
  envelope: Pick<SlackCommandEnvelope, "userId" | "channelId">,
  config: SlackAuthConfig
): boolean {
  if (config.allowedUserIds.size > 0 && (!envelope.userId || !config.allowedUserIds.has(envelope.userId))) {
    return false;
  }
  if (config.allowedChannelIds.size > 0 && (!envelope.channelId || !config.allowedChannelIds.has(envelope.channelId))) {
    return false;
  }
  return true;
}

export function textFromSlackEvent(event: unknown, teamId?: string): SlackCommandEnvelope | null {
  if (!isRecord(event)) return null;
  const eventType = stringField(event, "type");
  if (eventType !== "message" && eventType !== "app_mention") return null;
  if (stringField(event, "bot_id") || stringField(event, "subtype")) return null;
  const rawText = stringField(event, "text");
  if (!rawText) return null;
  const text = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return null;
  return {
    text,
    teamId,
    userId: stringField(event, "user"),
    channelId: stringField(event, "channel"),
    permalink: slackPermalinkFromParts(teamId, stringField(event, "channel"), stringField(event, "ts")),
  };
}

export function textFromSlashCommand(rawBody: string): SlackCommandEnvelope {
  const form = new URLSearchParams(rawBody);
  const command = form.get("command") ?? "";
  const text = form.get("text")?.trim() || command.replace(/^\//, "").trim();
  return {
    text,
    teamId: form.get("team_id") ?? undefined,
    userId: form.get("user_id") ?? undefined,
    channelId: form.get("channel_id") ?? undefined,
    responseUrl: form.get("response_url") ?? undefined,
  };
}

export function formatOperatorResultForSlack(result: unknown): string {
  if (!isRecord(result)) return "Averray operator command returned an empty response.";
  if (result.handled === false) {
    const examples = Array.isArray(result.examples) ? result.examples.map((entry) => `• \`${String(entry)}\``).join("\n") : "";
    return [`I did not recognize that Averray command.`, examples].filter(Boolean).join("\n");
  }
  if (result.kind === "status_last_wikipedia_citation_repair") {
    const detailed = result.detailed === true;
    const status = isRecord(result.status) ? result.status : {};
    if (status.found === false) return "No Wikipedia citation-repair run was found yet.";
    return [
      detailed ? "*Last Wikipedia citation repair - details*" : "*Last Wikipedia citation repair*",
      `• runId: \`${formatId(stringField(status, "runId"), detailed) ?? "unknown"}\``,
      `• jobId: \`${formatId(stringField(status, "jobId"), detailed) ?? "unknown"}\``,
      `• sessionId: \`${formatId(stringField(status, "sessionId"), detailed) ?? "unknown"}\``,
      `• status: \`${stringField(status, "status") ?? "unknown"}\``,
      `• submittedAt: \`${stringField(status, "submittedAt") ?? "n/a"}\``,
      `• draftId: \`${formatId(stringField(status, "draftId"), detailed) ?? "n/a"}\``,
      `• submit_succeeded: \`${String(Boolean(status.submitSucceeded))}\``,
      `• slack: ${stringField(status, "slackPermalink") ?? "n/a"}`,
      detailed ? `• source: \`${stringField(status, "source") ?? "n/a"}\`` : "Use `status last wikipedia citation repair details` for full IDs.",
    ].join("\n");
  }
  if (result.kind === "daily_operator_brief") {
    const brief = isRecord(result.brief) ? result.brief : {};
    const readiness = isRecord(brief.readiness) ? brief.readiness : {};
    const budget = isRecord(brief.budget) ? brief.budget : {};
    const latestRun = isRecord(brief.latestWikipediaCitationRepair) ? brief.latestWikipediaCitationRepair : {};
    const candidateJobs = Array.isArray(brief.candidateJobs) ? brief.candidateJobs : [];
    const actions = Array.isArray(brief.recommendedNextActions)
      ? brief.recommendedNextActions.slice(0, 4).map((entry) => `• ${String(entry)}`).join("\n")
      : "";
    return [
      "*Daily Averray operator brief*",
      stringField(brief, "headline") ?? "No headline available.",
      "",
      "*Readiness*",
      `• wallet: \`${stringField(readiness, "wallet") ?? "unknown"}\``,
      `• budget remaining: \`${numberField(budget, "todayUsdRemaining") ?? "n/a"} / ${numberField(budget, "perDayUsdMax") ?? "n/a"} USD\``,
      `• wikipedia repair: \`${stringField(readiness, "wikipediaCitationRepair") ?? "unknown"}\``,
      "*Latest run*",
      `• status: \`${stringField(latestRun, "status") ?? "none"}\``,
      `• jobId: \`${formatId(stringField(latestRun, "jobId"), false) ?? "n/a"}\``,
      candidateJobs.length > 0 ? `*Candidate jobs*\n${candidateJobs.slice(0, 3).map(formatCandidateJob).join("\n")}` : "",
      actions ? `*Recommended next actions*\n${actions}` : "",
      "This brief is read-only.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "find_safe_work") {
    const safeWork = isRecord(result.safeWork) ? result.safeWork : {};
    const items = Array.isArray(safeWork.safeWorkItems) ? safeWork.safeWorkItems : [];
    const blockers = Array.isArray(safeWork.blockers) ? safeWork.blockers : [];
    const itemLines = items.slice(0, 5).map(formatSafeWorkItem).join("\n");
    return [
      "*Safe work finder*",
      `• available: \`${String(safeWork.available === true)}\``,
      blockers.length > 0 ? `• blockers: \`${blockers.map(String).join(", ")}\`` : "",
      `• recommended: \`${stringField(safeWork, "recommendedCommand") ?? "operator status"}\``,
      stringField(safeWork, "nextMutationCommand") ? `• submit command: \`${stringField(safeWork, "nextMutationCommand")}\`` : "",
      itemLines ? `*Work items*\n${itemLines}` : "No safe work items are currently available.",
      "Discovery is read-only. Start with the dry-run command.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "agent_usefulness_plan") {
    const plan = isRecord(result.plan) ? result.plan : {};
    const immediate = isRecord(plan.immediate) ? plan.immediate : {};
    const surfaces = isRecord(plan.surfaces) ? plan.surfaces : {};
    const slack = isRecord(surfaces.slack) ? surfaces.slack : {};
    const commandCenter = isRecord(surfaces.commandCenter) ? surfaces.commandCenter : {};
    const mcp = isRecord(surfaces.mcp) ? surfaces.mcp : {};
    const useCases = Array.isArray(plan.useCases) ? plan.useCases : [];
    const tracks = Array.isArray(plan.nextImplementationTracks) ? plan.nextImplementationTracks : [];
    const useCaseLines = useCases.slice(0, 6).map(formatUseCase).join("\n");
    const trackLines = tracks.slice(0, 4).map((entry) => `• ${String(entry)}`).join("\n");
    return [
      "*Averray agent usefulness plan*",
      stringField(plan, "headline") ?? "I can help through Slack, Command Center, and MCP tools.",
      "",
      "*Right now*",
      `• safe work: \`${String(immediate.safeWorkAvailable === true)}\``,
      `• recommended: \`${stringField(immediate, "recommendedCommand") ?? "operator status"}\``,
      stringField(immediate, "nextMutationCommand") ? `• guarded mutation: \`${stringField(immediate, "nextMutationCommand")}\`` : "",
      "*Surfaces*",
      `• Slack: \`${stringField(slack, "status") ?? "unknown"}\``,
      `• Command Center/mobile: \`${stringField(commandCenter, "status") ?? "unknown"}\` (${stringField(commandCenter, "publicAccess") ?? "unknown"})`,
      `• MCP: \`${stringField(mcp, "status") ?? "unknown"}\``,
      useCaseLines ? `*Use cases*\n${useCaseLines}` : "",
      trackLines ? `*Next tracks*\n${trackLines}` : "",
      "Read-only plan. Use `what can you do for us details` in MCP/Workspace for the full structured JSON.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "business_ledger") {
    const ledger = isRecord(result.ledger) ? result.ledger : {};
    const summary = isRecord(ledger.summary) ? ledger.summary : {};
    const latestRun = isRecord(summary.latestWikipediaCitationRepair) ? summary.latestWikipediaCitationRepair : {};
    const budget = isRecord(summary.budget) ? summary.budget : {};
    const submissions = isRecord(summary.sevenDaySubmissions) ? summary.sevenDaySubmissions : {};
    const drafts = isRecord(summary.sevenDayDrafts) ? summary.sevenDayDrafts : {};
    const commands = isRecord(summary.sevenDayOperatorCommands) ? summary.sevenDayOperatorCommands : {};
    return [
      "*Averray business ledger*",
      "*Latest Wikipedia repair*",
      `• status: \`${stringField(latestRun, "status") ?? "none"}\``,
      `• jobId: \`${formatId(stringField(latestRun, "jobId"), false) ?? "n/a"}\``,
      `• submittedAt: \`${stringField(latestRun, "submittedAt") ?? "n/a"}\``,
      "*7-day work*",
      `• submissions: \`${numberField(submissions, "completed") ?? 0} completed / ${numberField(submissions, "failed") ?? 0} failed / ${numberField(submissions, "total") ?? 0} total\``,
      `• drafts: \`${numberField(drafts, "valid") ?? 0} valid / ${numberField(drafts, "invalid") ?? 0} invalid / ${numberField(drafts, "total") ?? 0} total\``,
      `• operator commands: \`${numberField(commands, "total") ?? 0} total (${numberField(commands, "slackRouted") ?? 0} via Slack)\``,
      "*Today*",
      `• budget: \`${numberField(budget, "todayUsdSpent") ?? "n/a"} / ${numberField(budget, "perDayUsdMax") ?? "n/a"} USD\``,
      `• open wiki repair jobs: \`${numberField(summary, "openWikipediaCitationRepairJobs") ?? "n/a"}\``,
      "Read-only ledger.",
    ].join("\n");
  }
  if (result.kind === "ops_health") {
    const ops = isRecord(result.health) ? result.health : {};
    const wallet = isRecord(ops.wallet) ? ops.wallet : {};
    const budget = isRecord(ops.budget) ? ops.budget : {};
    const controlPlane = isRecord(ops.controlPlane) ? ops.controlPlane : {};
    const tables = isRecord(controlPlane.tables) ? controlPlane.tables : {};
    const recentErrors = Array.isArray(controlPlane.recentErrors) ? controlPlane.recentErrors : [];
    const recentEvents = Array.isArray(controlPlane.recentOperatorEvents) ? controlPlane.recentOperatorEvents : [];
    const errorLines = recentErrors.slice(0, 3).map(formatRecentEvent).join("\n");
    const eventLines = recentEvents.slice(0, 3).map(formatRecentEvent).join("\n");
    return [
      "*Averray ops health*",
      `• health: \`${stringField(ops, "health") ?? "unknown"}\``,
      `• wallet: \`${wallet.walletReady === true ? "ready" : "not_ready"}\``,
      `• budget remaining: \`${numberField(budget, "todayUsdRemaining") ?? "n/a"} USD\``,
      "*Control plane*",
      `• submissions: \`${numberField(tables, "submissions") ?? 0}\``,
      `• drafts: \`${numberField(tables, "drafts") ?? 0}\``,
      `• operator events: \`${numberField(tables, "operatorEvents") ?? 0}\``,
      `• last operator event: \`${stringField(tables, "lastOperatorEventAt") ?? "n/a"}\``,
      errorLines ? `*Recent errors*\n${errorLines}` : "*Recent errors*\n• none recorded",
      eventLines ? `*Recent events*\n${eventLines}` : "",
      "Read-only health. Host disk/log/WAL checks still need the VPS ops script.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "operator_status") {
    const detailed = result.detailed === true;
    const status = isRecord(result.status) ? result.status : {};
    const agent = isRecord(status.agent) ? status.agent : {};
    const policy = isRecord(status.policy) ? status.policy : {};
    const budget = isRecord(policy.budget) ? policy.budget : {};
    const workflows = isRecord(status.workflows) ? status.workflows : {};
    const wikipedia = isRecord(workflows.wikipediaCitationRepair) ? workflows.wikipediaCitationRepair : {};
    const latestRun = isRecord(wikipedia.latestRun) ? wikipedia.latestRun : {};
    const candidateJobs = Array.isArray(wikipedia.candidateJobs) ? wikipedia.candidateJobs : [];
    const commands = Array.isArray(wikipedia.safeCommands)
      ? wikipedia.safeCommands.slice(0, 4).map((entry) => `• \`${String(entry)}\``).join("\n")
      : "";
    if (detailed) {
      return [
        "*Averray operator status - details*",
        `• generatedAt: \`${stringField(status, "generatedAt") ?? "n/a"}\``,
        `• mutates: \`${String(status.mutates === true)}\``,
        `• wallet: \`${agent.walletReady === true ? "ready" : "not_ready"}\``,
        `• address: \`${formatId(stringField(agent, "walletAddress"), true) ?? "n/a"}\``,
        `• network: \`${stringField(agent, "network") ?? "n/a"}\``,
        `• budget today: \`${numberField(budget, "todayUsdSpent") ?? "n/a"} / ${numberField(budget, "perDayUsdMax") ?? "n/a"} USD\``,
        `• wikipedia jobs: \`${numberField(wikipedia, "openJobs") ?? "n/a"} open / ${numberField(wikipedia, "discoveredJobs") ?? "n/a"} discovered\``,
        "*Latest run*",
        `• runId: \`${formatId(stringField(latestRun, "runId"), true) ?? "n/a"}\``,
        `• jobId: \`${formatId(stringField(latestRun, "jobId"), true) ?? "n/a"}\``,
        `• sessionId: \`${formatId(stringField(latestRun, "sessionId"), true) ?? "n/a"}\``,
        `• status: \`${stringField(latestRun, "status") ?? "none"}\``,
        `• draftId: \`${formatId(stringField(latestRun, "draftId"), true) ?? "n/a"}\``,
        `• slack: ${stringField(latestRun, "slackPermalink") ?? "n/a"}`,
        candidateJobs.length > 0 ? `*Open jobs*\n${candidateJobs.slice(0, 5).map(formatCandidateJob).join("\n")}` : "",
        commands ? `*Safe commands*\n${commands}` : "",
      ].filter(Boolean).join("\n");
    }
    return [
      "*Averray operator status*",
      `• wallet: \`${agent.walletReady === true ? "ready" : "not_ready"}\``,
      `• address: \`${formatId(stringField(agent, "walletAddress"), false) ?? "n/a"}\``,
      `• budget today: \`${numberField(budget, "todayUsdSpent") ?? "n/a"} / ${numberField(budget, "perDayUsdMax") ?? "n/a"} USD\``,
      `• wikipedia jobs: \`${numberField(wikipedia, "openJobs") ?? "n/a"} open / ${numberField(wikipedia, "discoveredJobs") ?? "n/a"} discovered\``,
      `• latest run: \`${stringField(latestRun, "status") ?? "none"}\``,
      `• latest job: \`${formatId(stringField(latestRun, "jobId"), false) ?? "n/a"}\``,
      commands ? `*Safe commands*\n${commands}` : "",
      "Use `operator status details` for full IDs.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "run_wikipedia_citation_repair") {
    const workflow = isRecord(result.result) ? result.result : {};
    const validation = isRecord(workflow.validation) ? workflow.validation : {};
    const evidence = isRecord(workflow.evidenceSummary) ? workflow.evidenceSummary : {};
    const proposal = isRecord(workflow.proposalSummary) ? workflow.proposalSummary : {};
    return [
      "*Wikipedia citation repair workflow*",
      `• status: \`${stringField(workflow, "status") ?? "unknown"}\``,
      `• runId: \`${formatId(stringField(workflow, "runId"), false) ?? "unknown"}\``,
      `• jobId: \`${formatId(stringField(workflow, "jobId"), false) ?? "unknown"}\``,
      `• sessionId: \`${formatId(stringField(workflow, "sessionId"), false) ?? "n/a"}\``,
      `• draftId: \`${formatId(stringField(workflow, "draftId"), false) ?? "n/a"}\``,
      `• confidence: \`${numberField(workflow, "confidence") ?? "n/a"}\``,
      `• validation: \`${validation.valid === true ? "valid" : validation.valid === false ? "invalid" : "n/a"}\``,
      `• citations reviewed: \`${numberField(evidence, "totalCitations") ?? "n/a"}\``,
      `• issues proposed: \`${numberField(proposal, "citationFindings") ?? "n/a"}\``,
      `• changes proposed: \`${numberField(proposal, "proposedChanges") ?? "n/a"}\``,
      `• reason: \`${stringField(workflow, "reason") ?? "n/a"}\``,
    ].join("\n");
  }
  return `Averray operator command completed:\n\`\`\`${JSON.stringify(result, null, 2).slice(0, 2500)}\`\`\``;
}

export function slackPermalinkFromParts(teamId: string | undefined, channelId: string | undefined, ts: string | undefined): string | undefined {
  if (!channelId || !ts) return undefined;
  const compactTs = ts.replace(".", "");
  if (teamId) return `https://app.slack.com/client/${teamId}/${channelId}/p${compactTs}`;
  return `slack://${channelId}/${ts}`;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function formatCandidateJob(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const jobId = formatId(stringField(value, "jobId"), true) ?? "unknown";
  const title = stringField(value, "title") ?? stringField(value, "pageTitle") ?? "untitled";
  const revisionId = stringField(value, "revisionId") ?? "n/a";
  return `• \`${jobId}\` - ${title} (rev ${revisionId})`;
}

function formatSafeWorkItem(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const job = isRecord(value.job) ? value.job : {};
  const rank = numberField(value, "rank") ?? "?";
  const jobId = formatId(stringField(job, "jobId"), true) ?? "unknown";
  const dryRunCommand = stringField(value, "dryRunCommand") ?? "run one wikipedia citation repair dry run only";
  return `• ${rank}. \`${jobId}\` - dry run: \`${dryRunCommand}\``;
}

function formatUseCase(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const id = stringField(value, "id") ?? "unknown";
  const status = stringField(value, "status") ?? "unknown";
  const summary = stringField(value, "value") ?? "";
  return `• \`${id}\` - ${status}${summary ? `: ${summary}` : ""}`;
}

function formatRecentEvent(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const command = stringField(value, "command") ?? "unknown";
  const source = stringField(value, "source") ?? "unknown";
  const status = stringField(value, "status") ?? "n/a";
  return `• \`${command}\` (${source}, ${status})`;
}

function formatId(value: string | undefined, detailed: boolean): string | undefined {
  if (!value) return undefined;
  return detailed ? value : compactId(value);
}

function compactId(value: string): string {
  if (value.length <= 32) return value;
  if (value.startsWith("0x") && value.length > 14) return `${value.slice(0, 6)}...${value.slice(-4)}`;
  if (value.includes(":0x")) return `${value.slice(0, 16)}...${value.slice(-9)}`;
  if (value.startsWith("wiki-en-")) return `${value.slice(0, 16)}...${value.slice(-9)}`;
  if (value.startsWith("wikipedia-citation")) return `${value.slice(0, 16)}...${value.slice(-10)}`;
  if (/^[a-f0-9]{48,}$/i.test(value)) return `${value.slice(0, 12)}...${value.slice(-10)}`;
  return `${value.slice(0, 16)}...${value.slice(-8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

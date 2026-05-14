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
    const decisionSummary = formatDailyBriefDecisionSummary(brief);
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
      decisionSummary,
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
  if (result.kind === "project_memory") {
    const memory = isRecord(result.memory) ? result.memory : {};
    const selected = isRecord(memory.selectedProject) ? memory.selectedProject : undefined;
    const projects = Array.isArray(memory.projects) ? memory.projects : [];
    if (selected) {
      const deploy = isRecord(selected.deploy) ? selected.deploy : {};
      const safety = isRecord(selected.safety) ? selected.safety : {};
      const commands = Array.isArray(selected.routineCommands) ? selected.routineCommands : [];
      const envs = Array.isArray(selected.environments) ? selected.environments : [];
      const questions = Array.isArray(selected.openQuestions) ? selected.openQuestions : [];
      return [
        `*Project memory - ${stringField(selected, "name") ?? stringField(selected, "id") ?? "unknown"}*`,
        stringField(selected, "role") ?? "No role recorded.",
        "",
        `• repos: ${arrayField(selected, "repos").map((entry) => `\`${String(entry)}\``).join(", ") || "`n/a`"}`,
        `• owner: \`${stringField(selected, "owner") ?? "unknown"}\``,
        envs.length > 0 ? `*Surfaces*\n${envs.slice(0, 4).map(formatProjectEnvironment).join("\n")}` : "",
        "*Deploy memory*",
        `• trigger: \`${stringField(deploy, "trigger") ?? "unknown"}\``,
        stringField(deploy, "workflow") ? `• workflow: \`${stringField(deploy, "workflow")}\`` : "",
        stringField(deploy, "script") ? `• script: \`${stringField(deploy, "script")}\`` : "",
        stringField(deploy, "command") ? `• command: \`${stringField(deploy, "command")}\`` : "",
        commands.length > 0 ? `*Useful commands*\n${commands.slice(0, 5).map((entry) => `• \`${String(entry)}\``).join("\n")}` : "",
        questions.length > 0 ? `*Open questions*\n${questions.slice(0, 3).map((entry) => `• ${String(entry)}`).join("\n")}` : "",
        `*Safety*\n• secrets stored: \`${String(safety.secretsInMemory === true)}\`\n• auto-admin: \`${String(safety.autoAdminEnabled === true || safety.autoMergeEnabled === true || safety.autoDeployEnabled === true)}\``,
        "Read-only project memory.",
      ].filter(Boolean).join("\n");
    }
    const lines = projects.slice(0, 6).map(formatProjectSummary).join("\n");
    return [
      "*Known project memory*",
      lines || "No projects are known yet.",
      "",
      "Try `project memory for averray-agent/agent` or `how do we deploy averray-agent/agent`.",
      "Read-only. No secrets are stored.",
    ].join("\n");
  }
  if (result.kind === "project_runbook") {
    const runbookEnvelope = isRecord(result.runbook) ? result.runbook : {};
    const runbook = isRecord(runbookEnvelope.runbook) ? runbookEnvelope.runbook : {};
    const project = isRecord(runbookEnvelope.project) ? runbookEnvelope.project : {};
    const target = isRecord(runbookEnvelope.target) ? runbookEnvelope.target : {};
    const safety = isRecord(runbookEnvelope.safety) ? runbookEnvelope.safety : {};
    const commands = arrayField(runbookEnvelope, "suggestedHermesCommands");
    const projectName = stringField(project, "name") ?? stringField(target, "name") ?? "unknown project";
    return [
      `*${stringField(runbookEnvelope, "title") ?? "Project admin runbook"}*`,
      stringField(runbook, "goal") ?? "Prepare a project-admin action safely.",
      "",
      `• action: \`${stringField(runbookEnvelope, "action") ?? "unknown"}\``,
      `• project: \`${projectName}\``,
      `• trigger: ${stringField(runbook, "trigger") ?? "n/a"}`,
      formatRunbookSection("Required evidence", arrayField(runbook, "requiredEvidence"), 5),
      formatRunbookSection("Operator steps", arrayField(runbook, "operatorSteps"), 5),
      formatRunbookSection("Stop if", arrayField(runbook, "stopConditions"), 4),
      formatRunbookSection("Verify after", arrayField(runbook, "postActionVerification"), 4),
      commands.length > 0 ? `*Suggested Hermes commands*\n${commands.slice(0, 4).map((entry) => `• \`${String(entry)}\``).join("\n")}` : "",
      `*Safety*\n• read-only: \`${String(safety.readOnly !== false)}\`\n• approval required: \`${String(safety.approvalRequired === true)}\`\n• mutates: \`${String(safety.mutates === true)}\`\n• secrets included: \`${String(safety.secretsIncluded === true)}\``,
      "Runbook-only. Hermes did not approve, merge, deploy, restart, rotate secrets, or mutate GitHub.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "admin_readiness") {
    const readiness = isRecord(result.readiness) ? result.readiness : {};
    const currentRole = isRecord(readiness.currentRole) ? readiness.currentRole : {};
    const state = isRecord(readiness.readiness) ? readiness.readiness : {};
    const ladder = Array.isArray(readiness.adminLadder) ? readiness.adminLadder : [];
    const canDoNow = Array.isArray(readiness.canDoNow) ? readiness.canDoNow : [];
    const notYet = Array.isArray(readiness.shouldNotDoYet) ? readiness.shouldNotDoYet : [];
    const required = Array.isArray(readiness.requiredBeforeProjectAdmin) ? readiness.requiredBeforeProjectAdmin : [];
    return [
      "*Averray admin readiness*",
      stringField(readiness, "headline") ?? "I can be an operator copilot now; broad admin needs staged controls.",
      "",
      "*Current role*",
      `• level: \`${stringField(currentRole, "level") ?? "operator_copilot"}\``,
      `• auto-admin: \`${String(currentRole.canAdministerAutomatically === true)}\``,
      `• overall: \`${stringField(state, "overall") ?? "unknown"}\``,
      `• access: Slack \`${stringField(state, "slackOperator") ?? "unknown"}\`, Command Center \`${stringField(state, "commandCenter") ?? "unknown"}\`, public \`${stringField(state, "publicAccess") ?? "unknown"}\``,
      "*Admin ladder*",
      ladder.slice(0, 5).map(formatAdminStage).join("\n"),
      canDoNow.length > 0 ? `*Can do now*\n${canDoNow.slice(0, 4).map((entry) => `• ${String(entry)}`).join("\n")}` : "",
      notYet.length > 0 ? `*Not yet*\n${notYet.slice(0, 4).map((entry) => `• ${String(entry)}`).join("\n")}` : "",
      required.length > 0 ? `*Before project admin*\n${required.slice(0, 3).map((entry) => `• ${String(entry)}`).join("\n")}` : "",
      "Read-only. Broad project-admin actions are denied by default until an approval policy exists.",
    ].filter(Boolean).join("\n");
  }
  if (result.kind === "admin_proposal") {
    const proposal = isRecord(result.proposal) ? result.proposal : {};
    const action = isRecord(proposal.action) ? proposal.action : {};
    const target = isRecord(action.target) ? action.target : {};
    const recommendation = isRecord(proposal.recommendation) ? proposal.recommendation : {};
    const approval = isRecord(proposal.approval) ? proposal.approval : {};
    const evidence = arrayField(proposal, "evidence");
    const risks = arrayField(proposal, "risks");
    const blocked = arrayField(proposal, "blockedActions");
    return [
      `*Admin proposal - ${stringField(action, "type") ?? "unknown"}*`,
      stringField(recommendation, "summary") ?? "Proposal generated.",
      "",
      "*Target*",
      `• repo: \`${stringField(target, "repo") ?? "n/a"}\``,
      `• PR: \`${numberField(target, "pullRequestNumber") ?? "n/a"}\``,
      `• sha: \`${formatId(stringField(target, "sha"), false) ?? "n/a"}\``,
      "*Recommendation*",
      `• status: \`${stringField(recommendation, "status") ?? "unknown"}\``,
      `• reason: \`${stringField(recommendation, "reason") ?? "unknown"}\``,
      `• approval required: \`${String(approval.required === true)}\``,
      evidence.length > 0 ? `*Evidence*\n${evidence.slice(0, 3).map(formatAdminProposalEvidence).join("\n")}` : "",
      risks.length > 0 ? `*Risks*\n${risks.slice(0, 4).map(formatAdminProposalRisk).join("\n")}` : "",
      blocked.length > 0 ? `*Blocked here*\n${blocked.slice(0, 5).map((entry) => `• \`${String(entry)}\``).join("\n")}` : "",
      stringField(proposal, "nextHumanStep") ? `*Next human step*\n${stringField(proposal, "nextHumanStep")}` : "",
      "Proposal-only. Hermes did not approve, merge, deploy, restart, rotate secrets, or mutate GitHub.",
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
  if (result.kind === "github_status") {
    return formatGithubStatusForSlack(result);
  }
  if (result.kind === "github_brief") {
    return formatGithubBriefForSlack(result);
  }
  if (result.kind === "run_testbed_e2e_read_only") {
    return formatTestbedE2eReadOnlyRunForSlack(result);
  }
  if (result.kind === "testbed_e2e_suite") {
    return formatTestbedE2eSuiteForSlack(result);
  }
  if (result.kind === "handoff_monitor") {
    return formatHandoffMonitorForSlack(result);
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

function formatAdminStage(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const stage = numberField(value, "stage") ?? "?";
  const name = stringField(value, "name") ?? "unknown";
  const status = stringField(value, "status") ?? "unknown";
  return `• ${stage}. ${name}: \`${status}\``;
}

function formatRecentEvent(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const command = stringField(value, "command") ?? "unknown";
  const source = stringField(value, "source") ?? "unknown";
  const status = stringField(value, "status") ?? "n/a";
  return `• \`${command}\` (${source}, ${status})`;
}

function formatGithubStatusForSlack(result: Record<string, unknown>): string {
  const github = isRecord(result.github) ? result.github : {};
  const detailed = result.detailed === true;
  const totals = isRecord(github.totals) ? github.totals : {};
  const selectedView = isRecord(github.selectedView) ? github.selectedView : {};
  const items = Array.isArray(selectedView.items) ? selectedView.items : [];
  const warnings = Array.isArray(github.warnings) ? github.warnings : [];
  const recommendations = Array.isArray(github.recommendations) ? github.recommendations : [];
  const configured = github.configured === true;
  const view = stringField(selectedView, "name") ?? stringField(result, "view") ?? "status";

  if (!configured) {
    const warningLines = warnings.slice(0, 4).map(formatGithubWarning).join("\n");
    return [
      "*GitHub operator status*",
      "GitHub read-only helper is not configured yet.",
      warningLines ? `*Missing setup*\n${warningLines}` : "",
      "*Needed*",
      "• `GITHUB_TOKEN` with read-only access to the target repo, or owner/repo-specific token maps",
      "• `GITHUB_DEFAULT_REPO=owner/repo` or `GITHUB_HELPER_REPOS=owner/repo,owner/repo`",
      "• Optional for multiple owners: `GITHUB_OWNER_TOKENS=owner=token` or `GITHUB_REPO_TOKENS=owner/repo=token`",
    ].filter(Boolean).join("\n");
  }

  return [
    `*GitHub ${view}*`,
    `• health: \`${stringField(github, "health") ?? "unknown"}\``,
    `• repos: \`${numberField(github, "repoCount") ?? 0}\``,
    `• open PRs: \`${numberField(totals, "openPullRequests") ?? 0}\``,
    `• open issues: \`${numberField(totals, "openIssues") ?? 0}\``,
    `• CI failing/active: \`${numberField(totals, "failingWorkflowRuns") ?? 0}/${numberField(totals, "activeWorkflowRuns") ?? 0}\``,
    items.length > 0 ? `*${githubViewTitle(view)}*\n${items.slice(0, detailed ? 10 : 5).map((item) => formatGithubItem(item, detailed)).join("\n")}` : "*Items*\n• none",
    warnings.length > 0 ? `*Warnings*\n${warnings.slice(0, 3).map(formatGithubWarning).join("\n")}` : "",
    recommendations.length > 0 ? `*Next*\n${recommendations.slice(0, 3).map((entry) => `• ${String(entry)}`).join("\n")}` : "",
    detailed ? "Read-only GitHub digest. No PRs, issues, workflows, or repo settings were changed." : "Use `github status details` for fuller IDs and more items.",
  ].filter(Boolean).join("\n");
}

function formatGithubBriefForSlack(result: Record<string, unknown>): string {
  const github = isRecord(result.github) ? result.github : {};
  const summary = isRecord(github.summary) ? github.summary : {};
  const sections = isRecord(github.sections) ? github.sections : {};
  const warnings = Array.isArray(github.warnings) ? github.warnings : [];
  const recommendations = Array.isArray(github.recommendations) ? github.recommendations : [];
  const configured = github.configured === true;

  if (!configured) {
    const warningLines = warnings.slice(0, 4).map(formatGithubWarning).join("\n");
    return [
      "*GitHub brief*",
      "GitHub read-only helper is not configured yet.",
      warningLines ? `*Missing setup*\n${warningLines}` : "",
      "*Needed*",
      "• `GITHUB_TOKEN` with read-only access to the target repo, or owner/repo-specific token maps",
      "• `GITHUB_DEFAULT_REPO=owner/repo` or `GITHUB_HELPER_REPOS=owner/repo,owner/repo`",
    ].filter(Boolean).join("\n");
  }

  const changed = arrayField(sections, "changed");
  const merged = arrayField(sections, "merged");
  const deployed = arrayField(sections, "deployed");
  const failed = arrayField(sections, "failed");
  const attention = arrayField(sections, "attention");
  return [
    "*GitHub brief*",
    github.isFirstBrief === true
      ? "Baseline saved. Future briefs will compare against this one."
      : `Since: \`${stringField(github, "since") ?? "previous brief"}\``,
    `• repos: \`${numberField(github, "repoCount") ?? 0}\``,
    `• changed/merged/deployed/failed/attention: \`${numberField(summary, "changed") ?? 0}/${numberField(summary, "merged") ?? 0}/${numberField(summary, "deployed") ?? 0}/${numberField(summary, "failed") ?? 0}/${numberField(summary, "attention") ?? 0}\``,
    changed.length > 0 ? `*Changed*\n${changed.slice(0, 5).map(formatGithubBriefItem).join("\n")}` : "*Changed*\n• none",
    merged.length > 0 ? `*Merged*\n${merged.slice(0, 5).map(formatGithubBriefItem).join("\n")}` : "*Merged*\n• none",
    deployed.length > 0 ? `*Deployed*\n${deployed.slice(0, 5).map(formatGithubBriefItem).join("\n")}` : "*Deployed*\n• none",
    failed.length > 0 ? `*Failed*\n${failed.slice(0, 5).map(formatGithubBriefItem).join("\n")}` : "*Failed*\n• none",
    attention.length > 0 ? `*Needs attention*\n${attention.slice(0, 5).map(formatGithubBriefItem).join("\n")}` : "*Needs attention*\n• none",
    recommendations.length > 0 ? `*Next*\n${recommendations.slice(0, 3).map((entry) => `• ${String(entry)}`).join("\n")}` : "",
    github.persistsLocalSnapshot === true
      ? "GitHub was not mutated; only the local brief checkpoint was updated."
      : "GitHub was not mutated. Local brief checkpoint was not saved.",
  ].filter(Boolean).join("\n");
}

function formatTestbedE2eSuiteForSlack(result: Record<string, unknown>): string {
  const suite = isRecord(result.suite) ? result.suite : {};
  const readiness = isRecord(suite.readiness) ? suite.readiness : {};
  const safety = isRecord(suite.safety) ? suite.safety : {};
  const commands = isRecord(suite.nextCommands) ? suite.nextCommands : {};
  const cases = arrayField(suite, "testCases");
  const blockers = arrayField(readiness, "blockers");
  const warnings = arrayField(readiness, "warnings");
  const readyCases = cases.filter((entry) => isRecord(entry) && stringField(entry, "status") === "ready").length;
  const mutatingCases = cases.filter((entry) => isRecord(entry) && entry.mutates === true).length;

  return [
    "*Averray testbed E2E suite*",
    stringField(suite, "headline") ?? "Canonical platform E2E test suite.",
    "",
    "*Readiness*",
    `• overall: \`${stringField(readiness, "overall") ?? "unknown"}\``,
    `• read-only: \`${String(readiness.canRunReadOnly === true)}\``,
    `• dry run: \`${String(readiness.canRunDryRun === true)}\``,
    `• guarded live: \`${String(readiness.canRunGuardedLive === true)}\``,
    blockers.length > 0 ? `• blockers: \`${blockers.map(String).join(", ")}\`` : "",
    warnings.length > 0 ? `• warnings: \`${warnings.slice(0, 3).map(String).join(", ")}\`` : "",
    "*Cases*",
    `• total: \`${cases.length}\``,
    `• ready: \`${readyCases}\``,
    `• mutating/manual: \`${mutatingCases}\``,
    cases.length > 0 ? cases.slice(0, 6).map(formatTestbedCase).join("\n") : "• none",
    "*Next commands*",
    `• suite: \`${stringField(commands, "readOnly") ?? "testbed e2e suite"}\``,
    `• dry run: \`${stringField(commands, "dryRun") ?? "run one wikipedia citation repair dry run only"}\``,
    `• guarded live: \`${stringField(commands, "guardedLive") ?? "run one wikipedia citation repair if safe"}\``,
    "*Safety*",
    `• suite mutates: \`${String(safety.suiteGeneratorMutates === true)}\``,
    `• live case mutates: \`${String(safety.guardedLiveCaseMutates === true)}\``,
    `• edits Wikipedia: \`${String(safety.editsWikipedia === true)}\``,
  ].filter(Boolean).join("\n");
}

function formatTestbedE2eReadOnlyRunForSlack(result: Record<string, unknown>): string {
  const run = isRecord(result.run) ? result.run : {};
  const summary = isRecord(run.summary) ? run.summary : {};
  const safety = isRecord(run.safety) ? run.safety : {};
  const cases = arrayField(run, "cases");
  const skippedBoundaries = arrayField(run, "skippedMutationBoundaries");
  const failedCases = cases.filter((entry) => isRecord(entry) && stringField(entry, "status") === "failed");
  const skippedCases = cases.filter((entry) => isRecord(entry) && stringField(entry, "status") === "skipped");

  return [
    "*Averray testbed E2E read-only run*",
    `• status: \`${stringField(run, "status") ?? "unknown"}\``,
    `• executed/passed/failed/skipped: \`${numberField(summary, "executed") ?? 0}/${numberField(summary, "passed") ?? 0}/${numberField(summary, "failed") ?? 0}/${numberField(summary, "skipped") ?? 0}\``,
    `• duration: \`${numberField(run, "durationMs") ?? "n/a"} ms\``,
    "",
    "*Cases*",
    cases.length > 0 ? cases.slice(0, 11).map(formatTestbedRunCase).join("\n") : "• none",
    failedCases.length > 0 ? `*Failed*\n${failedCases.slice(0, 5).map(formatTestbedRunCase).join("\n")}` : "",
    skippedCases.length > 0 ? `*Skipped intentionally*\n${skippedCases.slice(0, 5).map(formatTestbedRunCase).join("\n")}` : "",
    skippedBoundaries.length > 0 ? `*Mutation boundaries skipped*\n${skippedBoundaries.slice(0, 5).map(formatMutationBoundary).join("\n")}` : "",
    "*Safety*",
    `• run mutates: \`${String(safety.mutates === true)}\``,
    `• guarded live skipped: \`${String(safety.skippedGuardedLiveWorkflow === true)}\``,
    `• GitHub brief checkpoint skipped: \`${String(safety.skippedGithubBriefCheckpoint === true)}\``,
    `• edits Wikipedia: \`${String(safety.editsWikipedia === true)}\``,
  ].filter(Boolean).join("\n");
}

function formatHandoffMonitorForSlack(result: Record<string, unknown>): string {
  const monitor = isRecord(result.monitor) ? result.monitor : {};
  const counts = isRecord(monitor.counts) ? monitor.counts : {};
  const safety = isRecord(monitor.safety) ? monitor.safety : {};
  const active = arrayField(monitor, "active");
  const recent = arrayField(monitor, "recent");
  const activeIds = new Set(active.map((entry) => stringField(entry, "correlationId")).filter(Boolean));
  const recentCompleted = recent.filter((entry) => !activeIds.has(stringField(entry, "correlationId")));

  return [
    "*Hermes handoff monitor*",
    `• status: \`${stringField(monitor, "status") ?? "unknown"}\``,
    `• active/recent/events: \`${numberField(counts, "active") ?? active.length}/${numberField(counts, "recent") ?? recent.length}/${numberField(counts, "events") ?? 0}\``,
    "",
    "*Active now*",
    active.length > 0 ? active.slice(0, 5).map((entry) => formatHandoffSummary(entry, true)).join("\n") : "• none",
    "",
    "*Recent handoffs*",
    recentCompleted.length > 0
      ? recentCompleted.slice(0, 6).map((entry) => formatHandoffSummary(entry, false)).join("\n")
      : "• none in the monitor window",
    "",
    "*Safety*",
    `• read-only: \`${String(safety.readOnly !== false)}\``,
    `• GitHub mutated: \`${String(safety.githubMutated === true)}\``,
    `• Wikipedia edited: \`${String(safety.wikipediaEdited === true)}\``,
    `• free-form prompt: \`${String(safety.freeFormHermesPromptUsed === true)}\``,
  ].join("\n");
}

function formatHandoffSummary(value: unknown, includePhase: boolean): string {
  if (!isRecord(value)) return "• unknown handoff";
  const summary = isRecord(value.summary) ? value.summary : {};
  const release = handoffReleaseVerdict(value, summary);
  const status = stringField(value, "status") ?? "unknown";
  const phase = includePhase ? ` / ${stringField(value, "phase") ?? "unknown"}` : "";
  const target = formatHandoffTarget(value);
  const correlationId = formatId(stringField(value, "correlationId"), false) ?? "n/a";
  const intent = stringField(value, "intent") ?? "unknown";
  const tests = Array.isArray(value.testCaseIds) && value.testCaseIds.length > 0
    ? `\n  tests: \`${value.testCaseIds.map(String).join(", ")}\``
    : "";
  const verdict = stringField(summary, "finalVerdict") ?? stringField(summary, "status");
  const merge = stringField(summary, "mergeRecommendation");
  const review = stringField(summary, "codeReviewVerdict");
  const reason = stringField(value, "reason");
  const updatedAt = stringField(value, "updatedAt") ?? stringField(value, "startedAt");
  const links = formatHandoffLinks(value);
  const deployHealth = formatDeploymentHealthForSlack(summary);
  return [
    `• *${release.label}* ${target} - \`${intent}\` - \`${correlationId}\``,
    `  why: ${release.why}`,
    `  state: \`${status}${phase}\``,
    updatedAt ? `  updated: \`${updatedAt}\`` : "",
    links ? `  links: ${links}` : "",
    verdict ? `  verdict: \`${verdict}\`` : "",
    review ? `  code review: \`${review}\`` : "",
    merge ? `  merge: ${merge}` : "",
    reason ? `  reason: ${reason}` : "",
    deployHealth,
    tests,
  ].filter(Boolean).join("\n");
}

function handoffReleaseVerdict(value: Record<string, unknown>, summary: Record<string, unknown>): { label: string; why: string } {
  const status = normalizeToken(stringField(value, "status"));
  const finalVerdict = normalizeToken(stringField(summary, "finalVerdict") ?? stringField(summary, "status"));
  const mergeRecommendation = normalizeToken(stringField(summary, "mergeRecommendation"));
  const finalReason = normalizeToken(stringField(summary, "finalReason") ?? stringField(summary, "reason") ?? stringField(value, "reason"));
  const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons.filter(isRecord) : [];
  if (status === "running") return { label: "RUNNING", why: "Hermes is still working." };
  if (
    status === "failed" ||
    status === "blocked" ||
    includesToken(finalVerdict, ["block", "blocked", "failed", "failure", "hold"]) ||
    includesToken(mergeRecommendation, ["block", "blocked", "failed", "failure", "hold", "do_not_merge"]) ||
    includesToken(finalReason, ["deploy_failure", "deploy_failed", "ci_failed"])
  ) {
    return { label: "BLOCK", why: handoffWhy(summary, value, "block") };
  }
  if (
    status === "needs_review" ||
    includesToken(finalVerdict, ["review", "needs_review"]) ||
    includesToken(mergeRecommendation, ["review", "wait", "needs_review"]) ||
    includesToken(finalReason, ["github_needs_review", "pr_review_hold", "needs_review"]) ||
    reviewReasons.length > 0
  ) {
    return { label: "NEEDS REVIEW", why: handoffWhy(summary, value, "needs_review") };
  }
  return { label: "PASS", why: handoffWhy(summary, value, "pass") };
}

function handoffWhy(summary: Record<string, unknown>, value: Record<string, unknown>, level: string): string {
  const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons.filter(isRecord) : [];
  const firstReviewReason = reviewReasons[0];
  if (firstReviewReason) {
    const code = stringField(firstReviewReason, "code") ?? "review";
    const message = stringField(firstReviewReason, "message") ?? "Human review recommended.";
    return `${code}: ${message}`;
  }
  const reason = normalizeToken(stringField(summary, "finalReason") ?? stringField(summary, "reason") ?? stringField(value, "reason"));
  if (reason === "post_deploy_healthy") return "post-deploy suite, GitHub workflows, and hosted health are clean";
  if (reason === "hosted_health_failed") return "hosted health failed after deploy";
  if (reason === "github_workflow_failed") return "GitHub has a failed workflow";
  if (reason === "testbed_cases_failed") return "one or more read-only testbed cases failed";
  if (reason === "github_needs_review") return "GitHub still has a review signal open";
  if (reason === "pr_review_hold") return "PR risk gate held this for human review";
  if (reason === "ci_failed") return "CI failed";
  if (level === "pass") return "no blocking release signals recorded";
  return stringField(summary, "finalReason") ?? stringField(summary, "reason") ?? stringField(value, "reason") ?? "no reason recorded";
}

function formatHandoffLinks(value: Record<string, unknown>): string {
  const links: string[] = [];
  const prUrl = stringField(value, "pullRequestUrl") ?? derivePullRequestUrl(value);
  if (prUrl) links.push(`<${prUrl}|PR>`);
  const commitUrl = deriveCommitUrl(value);
  if (commitUrl) links.push(`<${commitUrl}|${formatId(stringField(value, "sha"), false) ?? "commit"}>`);
  const runUrl = deriveWorkflowRunUrl(value);
  if (runUrl) links.push(`<${runUrl}|workflow run>`);
  return links.join(" · ");
}

function formatDeploymentHealthForSlack(summary: Record<string, unknown>): string {
  const health = isRecord(summary.deploymentHealth) ? summary.deploymentHealth : {};
  if (Object.keys(health).length === 0) return "";
  const suite = [
    numberField(health, "suitePassed") !== undefined ? `pass ${numberField(health, "suitePassed")}` : "",
    numberField(health, "suiteFailed") !== undefined ? `fail ${numberField(health, "suiteFailed")}` : "",
    numberField(health, "suiteSkipped") !== undefined ? `skip ${numberField(health, "suiteSkipped")}` : "",
  ].filter(Boolean).join(" / ");
  const hosted = stringField(health, "hostedStatus");
  const github = stringField(health, "githubHealth");
  const ops = stringField(health, "opsStatus");
  const parts = [
    suite ? `suite ${suite}` : "",
    hosted ? `hosted ${hosted}` : "",
    github ? `github ${github}` : "",
    ops ? `ops ${ops}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `  deploy health: \`${parts.join(" · ")}\`` : "";
}

function formatHandoffTarget(value: Record<string, unknown>): string {
  const repo = stringField(value, "repo");
  const pr = numberField(value, "pullRequestNumber");
  const url = stringField(value, "pullRequestUrl");
  const label = repo && pr ? `${repo}#${pr}` : repo ?? "no repo";
  return url ? `<${url}|${label}>` : label;
}

function derivePullRequestUrl(value: Record<string, unknown>): string | undefined {
  const repo = stringField(value, "repo");
  const pr = numberField(value, "pullRequestNumber");
  if (!repo || !pr || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  return `https://github.com/${repo}/pull/${pr}`;
}

function deriveCommitUrl(value: Record<string, unknown>): string | undefined {
  const repo = stringField(value, "repo");
  const sha = stringField(value, "sha");
  if (!repo || !sha || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[a-f0-9]{7,40}$/i.test(sha)) {
    return undefined;
  }
  return `https://github.com/${repo}/commit/${sha}`;
}

function deriveWorkflowRunUrl(value: Record<string, unknown>): string | undefined {
  const repo = stringField(value, "repo");
  const correlationId = stringField(value, "correlationId");
  if (!repo || !correlationId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  const match = correlationId.match(/github-(?:pr|deploy)-(\d+)/);
  return match ? `https://github.com/${repo}/actions/runs/${match[1]}` : undefined;
}

function normalizeToken(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function includesToken(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function formatDailyBriefDecisionSummary(brief: Record<string, unknown>): string {
  const decisionSummary = isRecord(brief.decisionSummary) ? brief.decisionSummary : {};
  if (Object.keys(decisionSummary).length === 0) return "";
  const health = stringField(decisionSummary, "health") ?? "unknown";
  const attentionItems = arrayField(decisionSummary, "attentionItems");
  const suggestedActions = arrayField(decisionSummary, "suggestedActions");
  const attention = attentionItems.length > 0
    ? attentionItems.slice(0, 5).map(formatDailyBriefAttentionItem).join("\n")
    : "• none";
  const actions = suggestedActions.length > 0
    ? suggestedActions.slice(0, 4).map((entry) => `• \`${String(entry)}\``).join("\n")
    : "";
  return [
    "*Decision summary*",
    `• health: \`${health}\``,
    `*Needs attention*\n${attention}`,
    actions ? `*Suggested actions*\n${actions}` : "",
  ].filter(Boolean).join("\n");
}

function formatDailyBriefAttentionItem(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const severity = stringField(value, "severity") ?? "info";
  const source = stringField(value, "source") ?? "operator";
  const title = stringField(value, "title") ?? "needs attention";
  const detail = stringField(value, "detail");
  const url = stringField(value, "url");
  const suffix = [detail, url].filter(Boolean).join(" - ");
  return `• \`${severity}\` ${source}: ${title}${suffix ? ` — ${suffix}` : ""}`;
}

function formatAdminProposalEvidence(value: unknown): string {
  if (!isRecord(value)) return "• unknown evidence";
  return `• \`${stringField(value, "source") ?? "unknown"}\`: \`${stringField(value, "status") ?? "unknown"}\` - ${stringField(value, "detail") ?? "no detail"}`;
}

function formatAdminProposalRisk(value: unknown): string {
  if (!isRecord(value)) return "• unknown risk";
  return `• \`${stringField(value, "severity") ?? "info"}\` ${stringField(value, "code") ?? "risk"} - ${stringField(value, "message") ?? "no detail"}`;
}

function formatProjectSummary(value: unknown): string {
  if (!isRecord(value)) return "• unknown project";
  const repos = arrayField(value, "repos").map((entry) => String(entry)).join(", ");
  return `• *${stringField(value, "name") ?? stringField(value, "id") ?? "unknown"}* - ${repos ? `\`${repos}\` ` : ""}${stringField(value, "role") ?? "no role recorded"}`;
}

function formatProjectEnvironment(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const label = stringField(value, "name") ?? "surface";
  const target = stringField(value, "url") ?? stringField(value, "path") ?? stringField(value, "purpose") ?? "n/a";
  return `• ${label}: ${target}`;
}

function formatRunbookSection(title: string, values: unknown[], limit: number): string {
  if (values.length === 0) return "";
  return `*${title}*\n${values.slice(0, limit).map((entry) => `• ${String(entry)}`).join("\n")}`;
}

function githubViewTitle(view: string): string {
  if (view === "prs") return "Open PRs";
  if (view === "ci") return "Workflow runs";
  if (view === "issues") return "Open issues";
  if (view === "digest") return "Needs attention";
  return "Repositories";
}

function formatTestbedCase(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const surfaces = isRecord(value.surfaces) ? value.surfaces : {};
  const id = stringField(value, "id") ?? "unknown";
  const name = stringField(value, "name") ?? "untitled";
  const status = stringField(value, "status") ?? "unknown";
  const command = stringField(surfaces, "operatorCommand") ?? "operator status";
  const mutates = value.mutates === true ? " mutates" : "";
  return `• \`${id}\` ${name}: \`${status}${mutates}\` - \`${command}\``;
}

function formatTestbedRunCase(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const id = stringField(value, "id") ?? "unknown";
  const name = stringField(value, "name") ?? "untitled";
  const status = stringField(value, "status") ?? "unknown";
  const reason = stringField(value, "reason");
  const error = stringField(value, "error");
  const suffix = error ? ` - ${error}` : reason ? ` - ${reason}` : "";
  return `• \`${id}\` ${name}: \`${status}\`${suffix}`;
}

function formatMutationBoundary(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  return `• \`${stringField(value, "id") ?? "unknown"}\` ${stringField(value, "name") ?? "untitled"} - \`${stringField(value, "mutationScope") ?? "mutation"}\` (${stringField(value, "reason") ?? "skipped"})`;
}

function formatGithubItem(value: unknown, detailed: boolean): string {
  if (!isRecord(value)) return "• unknown";
  const kind = stringField(value, "kind");
  const repo = stringField(value, "repo") ?? "unknown";
  if (kind === "repo_status") {
    return `• \`${repo}\` - PRs ${numberField(value, "openPullRequests") ?? 0}, issues ${numberField(value, "openIssues") ?? 0}, CI fail/active ${numberField(value, "failingWorkflowRuns") ?? 0}/${numberField(value, "activeWorkflowRuns") ?? 0}`;
  }
  if (kind === "pull_request") {
    const draft = value.draft === true ? " draft" : "";
    return `• \`${repo}#${numberField(value, "number") ?? "?"}\`${draft} - ${stringField(value, "title") ?? "untitled"}${detailed ? linkSuffix(value) : ""}`;
  }
  if (kind === "issue") {
    const labels = Array.isArray(value.labels) && value.labels.length > 0 ? ` [${value.labels.map(String).join(", ")}]` : "";
    return `• \`${repo}#${numberField(value, "number") ?? "?"}\` - ${stringField(value, "title") ?? "untitled"}${labels}${detailed ? linkSuffix(value) : ""}`;
  }
  if (kind === "workflow_run") {
    const status = stringField(value, "conclusion") ?? stringField(value, "status") ?? "unknown";
    const branch = stringField(value, "branch") ? ` (${stringField(value, "branch")})` : "";
    return `• \`${repo}\` - ${stringField(value, "name") ?? "workflow"}: \`${status}\`${branch}${detailed ? linkSuffix(value) : ""}`;
  }
  if (kind === "digest_item") {
    const severity = stringField(value, "severity") ?? "info";
    return `• \`${severity}\`${repo !== "unknown" ? ` ${repo}` : ""} - ${stringField(value, "title") ?? "unknown"}${detailed ? linkSuffix(value) : ""}`;
  }
  return `• \`${repo}\` - ${stringField(value, "title") ?? kind ?? "unknown"}`;
}

function formatGithubWarning(value: unknown): string {
  if (!isRecord(value)) return "• unknown warning";
  const repo = stringField(value, "repo");
  return `• \`${stringField(value, "severity") ?? "warning"}\`${repo ? ` ${repo}` : ""}: ${stringField(value, "message") ?? stringField(value, "code") ?? "unknown"}`;
}

function formatGithubBriefItem(value: unknown): string {
  if (!isRecord(value)) return "• unknown";
  const repo = stringField(value, "repo");
  const detail = stringField(value, "detail");
  const occurredAt = stringField(value, "occurredAt");
  const meta = [repo, detail, occurredAt].filter(Boolean).join(" - ");
  return `• ${meta ? `\`${meta}\` ` : ""}${stringField(value, "title") ?? "unknown"}${linkSuffix(value)}`;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function linkSuffix(value: Record<string, unknown>): string {
  const url = stringField(value, "url");
  return url ? ` - ${url}` : "";
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

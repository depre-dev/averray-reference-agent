import { optionalEnv } from "@avg/mcp-common";
import type { OperatorStatusDeps } from "./operator-status.js";
import { getOperatorStatus, getSafeWorkReport } from "./operator-status.js";

export async function getAgentUsefulnessPlan(deps: OperatorStatusDeps) {
  const [status, safeWork] = await Promise.all([
    getOperatorStatus(deps),
    getSafeWorkReport(deps),
  ]);
  const wikipedia = status.workflows.wikipediaCitationRepair;
  const latestRun = wikipedia.latestRun;
  const slackEnabled = optionalEnv("SLACK_OPERATOR_ENABLED", "0") === "1";
  const dailyRoutineEnabled = optionalEnv("SLACK_OPERATOR_DAILY_BRIEF_ENABLED", "0") === "1";
  const safeWorkScanEnabled = Number.parseFloat(optionalEnv("SLACK_OPERATOR_SAFE_WORK_SCAN_INTERVAL_MINUTES", "0")) > 0;
  const commandCenterEnabled = Boolean(optionalEnv("HERMES_WORKSPACE_IMAGE"));
  const publicAccessEnabled = Boolean(optionalEnv("CLOUDFLARED_TUNNEL_TOKEN"));

  return {
    schemaVersion: 1,
    kind: "agent_usefulness_plan",
    generatedAt: status.generatedAt,
    mutates: false,
    headline: safeWork.available
      ? "I can already watch for safe Averray work, brief you, and run guarded Wikipedia citation-repair workflows."
      : "I can already brief, inspect, and explain status; guarded work starts when wallet, budget, and job inventory are ready.",
    immediate: {
      safeWorkAvailable: safeWork.available,
      blockers: safeWork.blockers,
      recommendedCommand: safeWork.recommendedCommand,
      nextMutationCommand: safeWork.nextMutationCommand,
      openWikipediaCitationRepairJobs: wikipedia.openJobs,
      latestWikipediaCitationRepair: latestRun,
    },
    surfaces: {
      slack: {
        status: slackEnabled ? "enabled" : "available",
        use: "Durable operator channel for briefings, alerts, status, and guarded workflow commands.",
        commands: [
          "brief me",
          "what can you do for us",
          "project memory",
          "runbook for deploy averray-agent/agent",
          "admin readiness",
          "what should i do next",
          "run one wikipedia citation repair dry run only",
          "run one wikipedia citation repair if safe",
        ],
        routines: {
          dailyBrief: dailyRoutineEnabled ? "enabled" : "off",
          safeWorkScan: safeWorkScanEnabled ? "enabled" : "off",
        },
      },
      commandCenter: {
        status: commandCenterEnabled ? "enabled" : "available",
        publicAccess: publicAccessEnabled ? "cloudflare_access_configured" : "private_or_tunnel_only",
        use: "Interactive inspection, dry-run preview, and controlled execution from desktop or phone browser.",
        commands: [
          "operator status",
          "daily operator brief",
          "what can you do for us",
          "project memory",
          "merge runbook for averray-agent/agent",
          "admin readiness",
          "find safe work",
        ],
      },
      mcp: {
        status: "enabled",
        use: "Canonical structured contract any compatible agent can call without learning Slack or Workspace.",
        tools: [
          "averray_agent_usefulness_plan",
          "averray_project_memory",
          "averray_project_runbook",
          "averray_admin_readiness",
          "averray_business_ledger",
          "averray_ops_health",
          "averray_operator_status",
          "averray_daily_operator_brief",
          "averray_find_safe_work",
          "averray_run_wikipedia_citation_repair",
        ],
      },
    },
    useCases: [
      {
        id: "slack_work_assistant",
        status: slackEnabled ? "enabled" : "available",
        value: "Posts compact operator answers where we already coordinate; routines can brief and watch for safe work.",
        commands: ["brief me", "what should i do next", "status last wikipedia citation repair"],
      },
      {
        id: "mobile_agent",
        status: publicAccessEnabled || slackEnabled ? "enabled" : "available",
        value: "Phone access through Slack or Cloudflare-protected Command Center, with short commands instead of terminal prompts.",
        commands: ["operator status", "find safe work", "run one wikipedia citation repair dry run only"],
      },
      {
        id: "github_helper",
        status: "next_integration",
        value: "Useful next track: watch PR/issue comments, summarize CI failures, and draft replies from GitHub context before any admin-grade GitHub actions.",
        commands: ["admin readiness"],
        nextStep: "Add a read-only GitHub digest command before allowing any write actions.",
      },
      {
        id: "project_admin_copilot",
        status: "readiness_enabled",
        value: "Can explain the staged path from operator copilot to approval-gated project admin, including denied actions and required controls.",
        commands: ["admin readiness", "what can you do for us"],
      },
      {
        id: "ops_caretaker",
        status: "enabled",
        value: "Can report wallet, budget, latest-run, recent command, and control-plane database health; host disk/log/WAL checks remain a VPS ops-script track.",
        commands: ["ops health", "operator status", "daily operator brief"],
      },
      {
        id: "averray_business_agent",
        status: "enabled",
        value: "Tracks latest run, available jobs, budget, seven-day submissions/drafts, and can recommend when to dry-run or submit.",
        commands: ["business ledger", "status last wikipedia citation repair", "find safe work"],
      },
      {
        id: "knowledge_memory",
        status: "enabled",
        value: "Provides curated non-secret project memory and read-only runbooks: repos, deploy surfaces, merge/deploy/rollback evidence, handoff expectations, safety notes, and open questions.",
        commands: ["project memory", "known projects", "how do we deploy averray-agent/agent", "runbook for deploy averray-agent/agent"],
      },
    ],
    nextImplementationTracks: [
      "GitHub PR/issue digest and CI failure explainer",
      "Admin action registry with project allowlists, approvals, audit receipts, and rollback notes",
      "Host-level ops routine for disk/log/WAL checks and stale sessions",
      "Reward ledger with chain/accounting reconciliation once payout data is exposed",
      "Portable command schema so Slack, Command Center, mobile, and future agents share the same intents",
    ],
    safety: {
      mutatesByDefault: false,
      readOnlyCommands: ["what can you do for us", "brief me", "operator status", "find safe work"],
      mutationRequiresExplicitCommand: true,
      validatesBeforeSubmit: true,
      editsWikipedia: false,
    },
  };
}

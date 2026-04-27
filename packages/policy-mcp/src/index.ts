import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNoKillSwitch, jsonContent, optionalEnv, query, readYamlFile, runStdioServer } from "@avg/mcp-common";

interface PolicyConfig {
  claim?: {
    allowed_task_types?: string[];
    reject_verifier_modes?: string[];
    min_reward_usd?: number;
  };
  submit?: {
    require_approval_if_confidence_lt?: number;
  };
  budget?: {
    per_run_usd_max?: number;
    per_day_usd_max?: number;
    max_browser_steps?: number;
  };
}

const defaultConfig: PolicyConfig = {
  claim: {
    allowed_task_types: ["citation_repair", "freshness_check"],
    reject_verifier_modes: ["human_fallback"],
    min_reward_usd: 0
  },
  submit: {
    require_approval_if_confidence_lt: 0.7
  },
  budget: {
    per_run_usd_max: 0.5,
    per_day_usd_max: 1,
    max_browser_steps: 80
  }
};

const server = new McpServer({
  name: "policy-mcp",
  version: "0.1.0"
});

server.tool("policy_check_claim", "Check whether the agent may claim a discovered Averray task.", {
  taskType: z.string().optional(),
  verifierMode: z.string().optional(),
  rewardUsd: z.number().default(0),
  estimatedCostUsd: z.number().default(0)
}, async (input) => {
  await assertNoKillSwitch("policy_check_claim");
  const config = loadPolicy();
  const reasons: string[] = [];
  const allowed = config.claim?.allowed_task_types ?? [];
  if (input.taskType && allowed.length > 0 && !allowed.includes(input.taskType)) {
    reasons.push(`task_type_not_allowed:${input.taskType}`);
  }
  if (input.verifierMode && (config.claim?.reject_verifier_modes ?? []).includes(input.verifierMode)) {
    reasons.push(`verifier_mode_rejected:${input.verifierMode}`);
  }
  if (input.rewardUsd < (config.claim?.min_reward_usd ?? 0)) {
    reasons.push("reward_below_minimum");
  }
  reasons.push(...(await budgetReasons(input.estimatedCostUsd, config)));
  return jsonContent({ decision: reasons.length ? "reject" : "pass", reasons, config });
});

server.tool("policy_check_submit", "Check whether the agent may submit, or whether human approval is required.", {
  confidence: z.number().min(0).max(1).default(0),
  costUsd: z.number().default(0),
  browserSteps: z.number().int().default(0)
}, async (input) => {
  await assertNoKillSwitch("policy_check_submit");
  const config = loadPolicy();
  const reasons = await budgetReasons(input.costUsd, config);
  if (input.browserSteps > (config.budget?.max_browser_steps ?? 80)) reasons.push("browser_step_cap_exceeded");
  if (reasons.length) return jsonContent({ decision: "reject", reasons, approvalRequired: false });
  const threshold = config.submit?.require_approval_if_confidence_lt ?? 0.7;
  const approvalRequired = input.confidence < threshold || input.costUsd > (config.budget?.per_run_usd_max ?? 0.5) * 0.5;
  return jsonContent({
    decision: approvalRequired ? "approval_required" : "pass",
    approvalRequired,
    reasons: approvalRequired ? ["confidence_or_budget_threshold"] : []
  });
});

server.tool("policy_get_budget", "Return current budget configuration and today's spend.", {}, async () => {
  const config = loadPolicy();
  const rows = await query<{ usd_spent: string }>("select usd_spent from budgets where date = current_date").catch(() => []);
  return jsonContent({
    config: config.budget,
    todayUsdSpent: Number(rows[0]?.usd_spent ?? 0)
  });
});

server.tool("policy_request_approval", "Create a human approval request and notify Slack if configured.", {
  runId: z.string().optional(),
  kind: z.enum(["claim", "submit", "wallet_signature", "shell_command"]),
  reason: z.string().min(1),
  request: z.unknown().default({})
}, async ({ runId, kind, reason, request }) => {
  const rows = await query<{ id: string }>(
    `insert into approvals(run_id, kind, reason, request)
     values ($1, $2, $3, $4::jsonb)
     returning id`,
    [runId ?? null, kind, reason, JSON.stringify(request)]
  );
  const approvalId = rows[0].id;
  await postSlack({
    text: `Averray Reference Agent approval required: ${kind}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Approval required:* ${kind}\n*Approval ID:* \`${approvalId}\`\n*Reason:* ${reason}`
        }
      }
    ]
  });
  return jsonContent({ approvalId, status: "pending" });
});

server.tool("policy_get_approval", "Read the current status of an approval request.", {
  approvalId: z.string().uuid()
}, async ({ approvalId }) => {
  const rows = await query("select * from approvals where id = $1", [approvalId]);
  return jsonContent(rows[0] ?? { status: "missing" });
});

server.tool("policy_record_approval", "Record a human approval decision. Use only from a trusted operator action.", {
  approvalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().optional()
}, async ({ approvalId, decision, note }) => {
  const rows = await query(
    `update approvals
     set status = $2, response = $3::jsonb, decided_at = now()
     where id = $1
     returning *`,
    [approvalId, decision, JSON.stringify({ note })]
  );
  return jsonContent(rows[0] ?? { status: "missing" });
});

await runStdioServer(server);

function loadPolicy(): PolicyConfig {
  return readYamlFile(optionalEnv("POLICY_CONFIG_PATH", "/config/policy.yaml"), defaultConfig);
}

async function budgetReasons(costUsd: number, config: PolicyConfig): Promise<string[]> {
  const reasons: string[] = [];
  if (costUsd > (config.budget?.per_run_usd_max ?? 0.5)) reasons.push("per_run_budget_exceeded");
  const rows = await query<{ usd_spent: string }>("select usd_spent from budgets where date = current_date").catch(() => []);
  const today = Number(rows[0]?.usd_spent ?? 0);
  if (today + costUsd > (config.budget?.per_day_usd_max ?? 1)) reasons.push("per_day_budget_exceeded");
  return reasons;
}

async function postSlack(payload: unknown): Promise<void> {
  const slackWebhookUrl = optionalEnv("SLACK_WEBHOOK_URL");
  if (!slackWebhookUrl) return;
  await fetch(slackWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => undefined);
}

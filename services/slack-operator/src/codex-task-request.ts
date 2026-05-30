// Pure validation for the POST /monitor/codex-tasks "propose" action.
//
// Extracted from the HTTP handler so the agent-aware payload rules can be
// unit-tested without standing up the server. The rule that matters:
//   - Codex tasks iterate an EXISTING PR, so a valid pullRequestNumber is
//     required.
//   - Claude tasks are GREENFIELD (the worker opens its own PR), so the PR is
//     optional — and only validated when the caller supplies one.
// The queue layer (proposeCodexTask) already supports both shapes; this is the
// untrusted-input gate in front of it, and it decides which agent runs.
import type { CodexTaskInput, TaskAgent } from "./codex-task-queue.js";

const TASK_AGENTS: readonly TaskAgent[] = ["codex", "claude"];

export type ParseProposeResult =
  | { ok: true; input: CodexTaskInput }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string field (mirrors the HTTP handler's stringField). */
function str(rec: Record<string, unknown>, key: string): string | undefined {
  const field = rec[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Numeric field, tolerating a numeric string (mirrors numberField). */
function num(field: unknown): number | undefined {
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field === "string" && field.trim().length > 0) {
    const parsed = Number.parseInt(field, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function requiredFieldsMessage(agent: TaskAgent): string {
  return agent === "claude"
    ? "repo and prompt are required to propose Claude work; pullRequestNumber is optional."
    : "repo, pullRequestNumber, and prompt are required to propose Codex work.";
}

export function parseProposeTaskPayload(payload: unknown): ParseProposeResult {
  if (!isRecord(payload)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const repo = str(payload, "repo");
  const prompt = str(payload, "prompt");

  const agentField = typeof payload.agent === "string" ? payload.agent.trim() : "";
  const agent = (agentField || "codex") as TaskAgent;
  if (!TASK_AGENTS.includes(agent)) {
    return { ok: false, message: `Unknown agent "${agentField}". Expected "codex" or "claude".` };
  }

  // A PR number is "supplied" only when the caller sent a non-empty value.
  const prSupplied =
    payload.pullRequestNumber !== undefined &&
    payload.pullRequestNumber !== null &&
    payload.pullRequestNumber !== "";
  const pullRequestNumber = prSupplied ? num(payload.pullRequestNumber) : undefined;
  const prValid =
    typeof pullRequestNumber === "number" &&
    Number.isInteger(pullRequestNumber) &&
    pullRequestNumber >= 1;

  if (!repo || !prompt) {
    return { ok: false, message: requiredFieldsMessage(agent) };
  }
  // Codex must target an existing PR.
  if (agent === "codex" && !prValid) {
    return { ok: false, message: requiredFieldsMessage(agent) };
  }
  // Any supplied PR (either agent) must be a positive integer.
  if (prSupplied && !prValid) {
    return { ok: false, message: "pullRequestNumber must be a positive integer." };
  }

  const correlationId = str(payload, "correlationId");
  const title = str(payload, "title");
  const reason = str(payload, "reason");

  const input: CodexTaskInput = {
    repo,
    prompt,
    agent,
    ...(prValid ? { pullRequestNumber } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(title ? { title } : {}),
    ...(reason ? { reason } : {}),
    requester: str(payload, "requester") ?? "monitor",
  };
  return { ok: true, input };
}

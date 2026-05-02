import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertNoKillSwitch,
  idempotencyKey,
  jsonContent,
  optionalEnv,
  query,
  runStdioServer,
  siweLogin,
  trimTrailingSlash
} from "@avg/mcp-common";
import { evaluateClaimMutationPolicy, evaluateSubmitMutationPolicy, isUuid } from "./mutation-policy.js";
import { postSlackAlert, validationFailureDetails } from "./slack-alerts.js";
import { buildSubmitRequestBody } from "./submit-payload.js";
import { validateSubmissionLocally } from "./validate-submission.js";

const server = new McpServer({
  name: "averray-mcp",
  version: "0.1.0"
});

const baseUrl = trimTrailingSlash(optionalEnv("AVERRAY_API_BASE_URL", "https://api.averray.com"));
const ttlAlertedSessions = new Set<string>();
const inventoryStateByScope = new Map<string, boolean>();

server.tool("averray_list_jobs", "List Averray jobs in compact form. Use search/source/category/state filters to find specific jobs without flooding context.", {
  recommendations: z.boolean().default(false),
  search: z.string().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  state: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25)
}, async ({ recommendations, search, source, category, state, limit }) => {
  const path = recommendations ? "/jobs/recommendations" : "/jobs";
  const payload = await request(path);
  const compact = compactJobsPayload(payload, { recommendations, search, source, category, state, limit });
  await maybePostInventoryAlert(compact, { recommendations, search, source, category, state, limit });
  return jsonContent(compact);
});

server.tool("averray_get_definition", "Get the canonical job definition for a job id.", {
  jobId: z.string().min(1)
}, async ({ jobId }) => {
  return jsonContent(await request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`));
});

server.tool("averray_claim", "Claim a job through Averray's public API fallback path.", {
  runId: z.string().optional(),
  jobId: z.string().min(1),
  idempotencyKey: z.string().optional()
}, async ({ runId, jobId, idempotencyKey: providedKey }) => {
  await assertNoKillSwitch("averray_claim");
  const key = providedKey ?? idempotencyKey(["averray", jobId, "claim"]);
  const definition = await safeGetDefinition(jobId);
  const policy = await evaluateClaimMutationPolicy({ runId, jobId, idempotencyKey: key }, query);
  if (!policy.allowed) {
    await postSlackAlert({
      kind: "claim_blocked",
      title: "claim blocked before mutation",
      identifiers: { jobId, runId: policy.runId },
      details: {
        reason: policy.reason,
        mutationBudgetConsumed: false,
        maxClaimAttempts: policy.maxClaimAttempts,
        previousAttempts: policy.previousAttempts,
        ...jobDefinitionDetails(definition),
      },
    });
    return jsonContent({ blocked: true, tool: "averray_claim", policy });
  }
  await postSlackAlert({
    kind: "claim_precheck_passed",
    title: "claim precheck passed",
    identifiers: { jobId, runId: policy.runId },
    details: {
      mutationBudgetConsumed: false,
      maxClaimAttempts: policy.maxClaimAttempts,
      previousAttempts: policy.previousAttempts,
      ...jobDefinitionDetails(definition),
    },
  });

  const session = await authSession();
  await upsertSubmission({ runId, kind: "claim", key, request: { jobId, policyRunId: policy.runId } });
  try {
    const response = await request("/jobs/claim", {
      method: "POST",
      token: session.token,
      body: { jobId, idempotencyKey: key }
    });
    await completeSubmission(key, response);
    const sessionDetails = sessionResponseDetails(response);
    await postSlackAlert({
      kind: "claim_succeeded",
      title: "claim succeeded",
      identifiers: {
        jobId,
        runId: policy.runId,
        sessionId: sessionDetails.sessionId,
        wallet: session.wallet,
      },
      details: {
        claimDeadline: sessionDetails.claimDeadline,
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        ...jobDefinitionDetails(definition),
      },
    });
    return jsonContent({ idempotencyKey: key, policy, response });
  } catch (error) {
    await failSubmission(key, error);
    await postSlackAlert({
      kind: "claim_failed",
      title: "claim failed after mutation attempt",
      identifiers: { jobId, runId: policy.runId, wallet: session.wallet },
      details: {
        error: error instanceof Error ? error.message : String(error),
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        ...jobDefinitionDetails(definition),
      },
    });
    throw error;
  }
});

server.tool(
  "averray_validate_submission",
  "Validate a structured submission output locally against the job's output schema. Read-only — does NOT consume the submit attempt budget and never calls the backend. Use this BEFORE averray_submit when an output schema is defined for the job source. Returns { valid, validator, errors[], message } where errors carry actionable JSON paths (e.g. citation_findings.0.citation_number is not allowed).",
  {
    jobId: z.string().min(1),
    output: z.unknown()
  },
  async ({ jobId, output }) => {
    const definition = await request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
    const validation = validateSubmissionLocally(definition, output);
    if (!validation.valid) {
      await postSlackAlert({
        kind: "submit_validation_failed",
        title: "local submission validation failed",
        identifiers: { jobId },
        details: {
          mutationBudgetConsumed: false,
          ...validationFailureDetails(validation),
          ...jobDefinitionDetails(definition),
        },
      });
    }
    return jsonContent({ jobId, ...validation });
  }
);

server.tool("averray_submit", "Submit work through Averray's public API fallback path. Runs the same local schema validation as averray_validate_submission BEFORE the mutation policy check, so an invalid payload (e.g. extra structured fields) is rejected without consuming the one-shot submit attempt.", {
  runId: z.string().optional(),
  sessionId: z.string().min(1),
  jobId: z.string().optional(),
  output: z.unknown(),
  outputHash: z.string().optional()
}, async ({ runId, sessionId, jobId, output, outputHash }) => {
  await assertNoKillSwitch("averray_submit");

  // Pre-flight schema validation — runs BEFORE the mutation policy
  // check and BEFORE any HTTP call. The reference agent has
  // `maxSubmitAttempts=1`; without this gate a single field-shape
  // mistake (the citation_number bug from the reference run) burns
  // the only attempt and then `max_submit_attempts_exceeded` blocks
  // the corrected payload. We need a jobId to pull the right schema;
  // when the agent omits it (legacy path) we skip validation rather
  // than refusing the submit.
  if (typeof jobId === "string" && jobId.length > 0) {
    let definition: unknown;
    try {
      definition = await request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
    } catch (error) {
      // Couldn't reach the definition endpoint — surface the error to
      // the agent rather than silently skipping validation. The
      // mutation budget is untouched.
      await postSlackAlert({
        kind: "submit_blocked",
        title: "submit blocked before mutation",
        identifiers: { jobId, runId, sessionId },
        details: {
          reason: "definition_fetch_failed",
          message: error instanceof Error ? error.message : String(error),
          mutationBudgetConsumed: false,
        },
      });
      return jsonContent({
        blocked: true,
        tool: "averray_submit",
        reason: "definition_fetch_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    const validation = validateSubmissionLocally(definition, output);
    if (!validation.valid) {
      await postSlackAlert({
        kind: "submit_validation_failed",
        title: "local submission validation failed",
        identifiers: { jobId, runId, sessionId },
        details: {
          mutationBudgetConsumed: false,
          ...validationFailureDetails(validation),
          ...jobDefinitionDetails(definition),
        },
      });
      return jsonContent({
        blocked: true,
        tool: "averray_submit",
        reason: "local_schema_validation_failed",
        validation
      });
    }
  }

  const key = idempotencyKey(["averray", runId ?? sessionId, "submit", outputHash ?? JSON.stringify(output)]);
  const policy = await evaluateSubmitMutationPolicy({ runId, sessionId, jobId, idempotencyKey: key }, query);
  if (!policy.allowed) {
    await postSlackAlert({
      kind: "submit_blocked",
      title: "submit blocked before mutation",
      identifiers: { jobId: policy.jobId, runId: policy.runId, sessionId },
      details: {
        reason: policy.reason,
        mutationBudgetConsumed: false,
        maxSubmitAttempts: policy.maxSubmitAttempts,
        previousAttempts: policy.previousAttempts,
      },
    });
    return jsonContent({ blocked: true, tool: "averray_submit", policy });
  }

  const session = await authSession();
  await upsertSubmission({ runId, kind: "submit", key, request: { sessionId, jobId, outputHash, policyRunId: policy.runId } });
  try {
    const response = await request("/jobs/submit", {
      method: "POST",
      token: session.token,
      body: buildSubmitRequestBody({ sessionId, output })
    });
    await completeSubmission(key, response);
    await postSlackAlert({
      kind: "submit_succeeded",
      title: "submit succeeded",
      identifiers: { jobId, runId: policy.runId, sessionId, wallet: session.wallet },
      details: {
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        outputHash,
        ...submitResponseDetails(response),
      },
    });
    return jsonContent({ idempotencyKey: key, policy, response });
  } catch (error) {
    await failSubmission(key, error);
    await postSlackAlert({
      kind: "submit_failed",
      title: "submit failed after mutation attempt",
      identifiers: { jobId, runId: policy.runId, sessionId, wallet: session.wallet },
      details: {
        error: error instanceof Error ? error.message : String(error),
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        outputHash,
      },
    });
    throw error;
  }
});

server.tool("averray_observe_session", "Read the current Averray session state after claim/submit.", {
  sessionId: z.string().min(1)
}, async ({ sessionId }) => {
  const session = await authSession();
  const payload = await request(`/session?sessionId=${encodeURIComponent(sessionId)}`, { token: session.token });
  await maybePostTtlAlert(sessionId, payload, session.wallet);
  return jsonContent(payload);
});

await runStdioServer(server);

async function authSession() {
  const cached = await query<{ wallet: string; jwt: string; expires_at: string | null }>(
    "select wallet, jwt, expires_at from auth_sessions where expires_at is null or expires_at > now() + interval '60 seconds' limit 1"
  ).catch(() => []);
  if (cached[0]) return { wallet: cached[0].wallet, token: cached[0].jwt, expiresAt: cached[0].expires_at ?? undefined };
  const session = await siweLogin(baseUrl);
  await query(
    `insert into auth_sessions(wallet, jwt, expires_at)
     values ($1, $2, $3)
     on conflict(wallet) do update set jwt = excluded.jwt, expires_at = excluded.expires_at`,
    [session.wallet, session.token, session.expiresAt ?? null]
  ).catch(() => []);
  return session;
}

async function request(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${payload?.message ?? "unknown_error"}`);
  }
  return payload;
}

async function safeGetDefinition(jobId: string): Promise<unknown> {
  try {
    return await request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
  } catch {
    return undefined;
  }
}

async function upsertSubmission(input: { runId?: string; kind: "claim" | "submit"; key: string; request: unknown }) {
  await query(
    `insert into submissions(run_id, kind, idempotency_key, request, status, attempts)
     values ($1, $2, $3, $4::jsonb, 'started', 1)
     on conflict(idempotency_key) do update
     set attempts = submissions.attempts + 1, updated_at = now()`,
    [isUuid(input.runId) ? input.runId : null, input.kind, input.key, JSON.stringify(input.request)]
  );
}

async function completeSubmission(key: string, response: unknown) {
  await query(
    `update submissions set response = $2::jsonb, status = 'completed', updated_at = now()
     where idempotency_key = $1`,
    [key, JSON.stringify(response)]
  ).catch(() => undefined);
}

async function failSubmission(key: string, error: unknown) {
  await query(
    `update submissions set last_error = $2, status = 'failed', updated_at = now()
     where idempotency_key = $1`,
    [key, error instanceof Error ? error.message : String(error)]
  ).catch(() => undefined);
}

function compactJobsPayload(
  payload: unknown,
  filters: {
    recommendations: boolean;
    search?: string;
    source?: string;
    category?: string;
    state?: string;
    limit: number;
  }
) {
  const jobs = extractJobArray(payload);
  const filtered = jobs.filter((job) => matchesJob(job, filters));
  const limited = filtered.slice(0, filters.limit).map(compactJob);
  return {
    total: jobs.length,
    matched: filtered.length,
    returned: limited.length,
    filters: {
      recommendations: filters.recommendations,
      search: filters.search ?? null,
      source: filters.source ?? null,
      category: filters.category ?? null,
      state: filters.state ?? null,
      limit: filters.limit
    },
    jobs: limited,
    note:
      filtered.length > limited.length
        ? "Result was truncated. Re-run with a narrower search/source/category/state filter or a higher limit."
        : "Use averray_get_definition(jobId) for full details before planning work."
  };
}

async function maybePostInventoryAlert(
  compact: ReturnType<typeof compactJobsPayload>,
  filters: { recommendations: boolean; search?: string; source?: string; category?: string; state?: string; limit: number }
) {
  const scope = JSON.stringify({
    recommendations: filters.recommendations,
    search: filters.search ?? null,
    source: filters.source ?? null,
    category: filters.category ?? null,
    state: filters.state ?? null,
  });
  const hasInventory = compact.matched > 0;
  const previous = inventoryStateByScope.get(scope);
  inventoryStateByScope.set(scope, hasInventory);
  if (previous === undefined && hasInventory) return;
  if (previous === hasInventory) return;
  if (hasInventory) {
    await postSlackAlert({
      kind: "inventory_replenished",
      title: "job inventory replenished",
      identifiers: { scope },
      details: { matched: compact.matched, total: compact.total, returned: compact.returned },
    });
    return;
  }
  await postSlackAlert({
    kind: "inventory_exhausted",
    title: "job inventory exhausted",
    identifiers: { scope },
    details: { matched: compact.matched, total: compact.total, returned: compact.returned },
  });
}

async function maybePostTtlAlert(sessionId: string, payload: unknown, wallet: string) {
  const deadline = firstDeepString(payload, ["claimExpiresAt", "claim_expires_at", "claimDeadline", "deadline"]);
  if (!deadline) return;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return;
  const ttlMs = deadlineMs - Date.now();
  const thresholdMs = Number.parseInt(optionalEnv("AVERRAY_SLACK_TTL_WARNING_MS", "600000"), 10);
  if (ttlMs <= 0 || ttlMs > thresholdMs) return;
  const state = firstDeepString(payload, ["status", "state"]);
  if (state && !["claimed", "active", "open"].includes(state.toLowerCase())) return;
  const key = `${sessionId}:${deadline}`;
  if (ttlAlertedSessions.has(key)) return;
  ttlAlertedSessions.add(key);
  await postSlackAlert({
    kind: "ttl_nearing_expiry",
    title: "claim TTL nearing expiry",
    identifiers: {
      jobId: firstDeepString(payload, ["jobId", "job_id"]),
      runId: firstDeepString(payload, ["runId", "run_id"]),
      sessionId,
      wallet,
    },
    details: {
      claimDeadline: deadline,
      ttlSecondsRemaining: Math.max(0, Math.round(ttlMs / 1000)),
      state,
      mutationBudgetConsumed: false,
    },
  });
}

function jobDefinitionDetails(definition: unknown) {
  if (!isRecord(definition)) return {};
  const source = isRecord(definition.source) ? definition.source : {};
  const reward = isRecord(definition.reward) ? definition.reward : {};
  return {
    title: firstString(definition.title, definition.name, definition.summary),
    source: firstString(source.type, source.kind, definition.sourceType, definition.source),
    taskType: firstString(source.taskType, definition.taskType),
    verifierMode: firstString(definition.verifierMode, definition.verifier),
    reward: firstPresent(definition.rewardAmount, reward.amount, definition.reward),
    rewardAsset: firstString(definition.rewardAsset, reward.asset),
  };
}

function sessionResponseDetails(response: unknown) {
  return {
    sessionId: firstDeepString(response, ["sessionId", "session_id"]),
    claimDeadline: firstDeepString(response, ["claimExpiresAt", "claim_expires_at", "claimDeadline", "deadline"]),
  };
}

function submitResponseDetails(response: unknown) {
  return {
    verifierMode: firstDeepString(response, ["verifierMode", "verifier_mode"]),
    reward: firstDeepString(response, ["reward", "rewardAmount", "reward_amount"]),
    state: firstDeepString(response, ["state", "status"]),
  };
}

function firstDeepString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.length > 0) return direct;
  }
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const match = firstDeepString(nested, keys, depth + 1);
      if (match) return match;
    }
  }
  return undefined;
}

function extractJobArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["jobs", "items", "data", "recommendations", "results", "rows"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function matchesJob(
  job: unknown,
  filters: { search?: string; source?: string; category?: string; state?: string }
): boolean {
  const haystack = JSON.stringify(job).toLowerCase();
  if (filters.search && !haystack.includes(filters.search.toLowerCase())) return false;
  if (filters.source && !haystack.includes(filters.source.toLowerCase())) return false;
  if (filters.category && !haystack.includes(filters.category.toLowerCase())) return false;
  if (filters.state && !hasFieldValue(job, ["state", "status"], filters.state)) return false;
  return true;
}

function compactJob(job: unknown) {
  if (!isRecord(job)) return job;
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const source = isRecord(job.source) ? job.source : {};
  return {
    id: firstString(job.id, job.jobId, job.externalTaskId),
    title: firstString(job.title, job.name, metadata.title),
    state: firstString(job.state, job.status),
    source: firstString(job.source, job.kind, source.type, source.kind, metadata.source, metadata.platform),
    category: firstString(job.category, job.type, metadata.category, metadata.taskType),
    stake: firstPresent(job.stake, job.reward, job.rewardAmount, metadata.stake, metadata.reward),
    createdAt: firstString(job.createdAt, job.created_at, metadata.createdAt),
    sessionId: firstString(job.sessionId, job.session_id),
    summary: firstString(job.description, job.summary, metadata.description)
  };
}

function hasFieldValue(job: unknown, keys: string[], expected: string): boolean {
  if (!isRecord(job)) return false;
  const normalizedExpected = expected.toLowerCase();
  return keys.some((key) => String(job[key] ?? "").toLowerCase() === normalizedExpected);
}

function firstString(...values: unknown[]): string | null {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return typeof value === "string" ? value : null;
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((candidate) => candidate !== undefined && candidate !== null) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

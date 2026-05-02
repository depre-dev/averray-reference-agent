import { privateKeyToAccount } from "viem/accounts";
import {
  assertNoKillSwitch,
  idempotencyKey,
  optionalEnv,
  query,
  siweLogin,
  trimTrailingSlash,
} from "@avg/mcp-common";
import { evaluateClaimMutationPolicy, evaluateSubmitMutationPolicy, isUuid } from "./mutation-policy.js";
import { postSlackAlert } from "./slack-alerts.js";
import { buildSubmitRequestBody } from "./submit-payload.js";
import {
  getDraftSubmission,
  markDraftValidation,
  saveDraftSubmission,
} from "./draft-submissions.js";
import { validateSubmissionLocally } from "./validate-submission.js";
import {
  checkSourceUrl,
  fetchWikipediaRevision,
  findArchiveSnapshot,
} from "./wiki-evidence.js";
import {
  readPageTitle,
  readRevisionId,
  type WikipediaEvidenceBundle,
  type WorkflowDeps,
  type WorkflowJob,
} from "./job-workflows.js";

const baseUrl = trimTrailingSlash(optionalEnv("AVERRAY_API_BASE_URL", "https://api.averray.com"));

export function createDefaultWorkflowDeps(): WorkflowDeps {
  return {
    async listJobs(): Promise<WorkflowJob[]> {
      const payload = await request("/jobs");
      const jobs: WorkflowJob[] = [];
      for (const job of extractJobArray(payload)) {
        if (isRecord(job)) {
          const jobId = firstString(job.id, job.jobId, job.externalTaskId);
          if (jobId) jobs.push({ jobId, definition: job });
        }
      }
      return jobs;
    },
    async getDefinition(jobId: string) {
      return request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
    },
    async walletStatus() {
      const privateKey = optionalEnv("AGENT_WALLET_PRIVATE_KEY");
      if (!privateKey) return { configured: false, address: null };
      try {
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        return { configured: true, address: account.address };
      } catch {
        return { configured: false, address: null };
      }
    },
    async policyCheckClaim(input) {
      const reasons: string[] = [];
      if (input.taskType && input.taskType !== "citation_repair") {
        reasons.push(`task_type_not_allowed:${input.taskType}`);
      }
      if (input.verifierMode === "human_fallback") {
        reasons.push("verifier_mode_rejected:human_fallback");
      }
      if (reasons.length > 0) {
        return { allowed: false, reason: reasons.join(","), details: { reasons } };
      }
      const key = idempotencyKey(["averray", input.jobId, "claim"]);
      const policy = await evaluateClaimMutationPolicy({ runId: input.runId, jobId: input.jobId, idempotencyKey: key }, query);
      return {
        allowed: policy.allowed,
        reason: policy.allowed ? undefined : policy.reason ?? undefined,
        details: policy,
      };
    },
    async claim(input) {
      return claimOnceForWorkflow(input);
    },
    async fetchEvidence(input): Promise<WikipediaEvidenceBundle> {
      return fetchWikipediaEvidenceForWorkflow(input.definition, input.maxEvidenceUrls);
    },
    async saveDraft(input) {
      const draft = await saveDraftSubmission(
        { ...input, proposalOnly: true, noWikipediaEdit: true },
        query
      );
      return { draftId: draft.draftId, outputHash: draft.outputHash };
    },
    async validate(input) {
      const definition = await request(`/jobs/definition?jobId=${encodeURIComponent(input.jobId)}`);
      if (input.draftId) {
        const draft = await getDraftSubmission(
          { draftId: input.draftId, runId: input.runId, jobId: input.jobId, sessionId: input.sessionId },
          query
        );
        const validation = validateSubmissionLocally(definition, draft.output);
        await markDraftValidation(draft.draftId, validation.valid, validation, query);
        return validation;
      }
      return validateSubmissionLocally(definition, input.output);
    },
    async submit(input) {
      return submitDraftOnceForWorkflow(input);
    },
  };
}

async function claimOnceForWorkflow(input: { runId: string; jobId: string }) {
  await assertNoKillSwitch("averray_claim");
  const key = idempotencyKey(["averray", input.jobId, "claim"]);
  const definition = await safeGetDefinition(input.jobId);
  const policy = await evaluateClaimMutationPolicy(
    { runId: input.runId, jobId: input.jobId, idempotencyKey: key },
    query
  );
  if (!policy.allowed) {
    await postSlackAlert({
      kind: "claim_blocked",
      title: "workflow claim blocked before mutation",
      identifiers: { jobId: input.jobId, runId: policy.runId },
      details: {
        reason: policy.reason,
        mutationBudgetConsumed: false,
        maxClaimAttempts: policy.maxClaimAttempts,
        previousAttempts: policy.previousAttempts,
        ...jobDefinitionDetails(definition),
      },
    });
    throw new Error(`claim_blocked:${policy.reason}`);
  }

  const session = await authSession();
  await upsertSubmission({ runId: input.runId, kind: "claim", key, request: { jobId: input.jobId, policyRunId: policy.runId } });
  try {
    const response = await request("/jobs/claim", {
      method: "POST",
      token: session.token,
      body: { jobId: input.jobId, idempotencyKey: key },
    });
    await completeSubmission(key, response);
    const details = sessionResponseDetails(response);
    await postSlackAlert({
      kind: "claim_succeeded",
      title: "workflow claim succeeded",
      identifiers: { jobId: input.jobId, runId: policy.runId, sessionId: details.sessionId, wallet: session.wallet },
      details: {
        claimDeadline: details.claimDeadline,
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        ...jobDefinitionDetails(definition),
      },
    });
    if (!details.sessionId) throw new Error("claim_response_missing_session_id");
    return { sessionId: details.sessionId, claimDeadline: details.claimDeadline, response };
  } catch (error) {
    await failSubmission(key, error);
    await postSlackAlert({
      kind: "claim_failed",
      title: "workflow claim failed after mutation attempt",
      identifiers: { jobId: input.jobId, runId: policy.runId, wallet: session.wallet },
      details: {
        error: error instanceof Error ? error.message : String(error),
        mutationBudgetConsumed: true,
        idempotencyKey: key,
      },
    });
    throw error;
  }
}

async function submitDraftOnceForWorkflow(input: {
  runId: string;
  jobId: string;
  sessionId: string;
  draftId: string;
  outputHash?: string;
}) {
  await assertNoKillSwitch("averray_submit");
  const definition = await request(`/jobs/definition?jobId=${encodeURIComponent(input.jobId)}`);
  const draft = await getDraftSubmission({ draftId: input.draftId, jobId: input.jobId, sessionId: input.sessionId }, query);
  const validation = validateSubmissionLocally(definition, draft.output);
  await markDraftValidation(draft.draftId, validation.valid, validation, query);
  if (!validation.valid) {
    return { blocked: true, reason: "local_schema_validation_failed", validation };
  }

  const outputHash = input.outputHash ?? draft.outputHash;
  const key = idempotencyKey(["averray", input.runId, "submit", outputHash]);
  const policy = await evaluateSubmitMutationPolicy({
    runId: input.runId,
    sessionId: input.sessionId,
    jobId: input.jobId,
    idempotencyKey: key,
  }, query);
  if (!policy.allowed) {
    await postSlackAlert({
      kind: "submit_blocked",
      title: "workflow submit blocked before mutation",
      identifiers: { jobId: policy.jobId, runId: policy.runId, sessionId: input.sessionId },
      details: {
        reason: policy.reason,
        mutationBudgetConsumed: false,
        maxSubmitAttempts: policy.maxSubmitAttempts,
        previousAttempts: policy.previousAttempts,
      },
    });
    return { blocked: true, reason: policy.reason ?? undefined, policy };
  }

  const session = await authSession();
  await upsertSubmission({
    runId: input.runId,
    kind: "submit",
    key,
    request: { sessionId: input.sessionId, jobId: input.jobId, draftId: input.draftId, outputHash, policyRunId: policy.runId },
  });
  try {
    const response = await request("/jobs/submit", {
      method: "POST",
      token: session.token,
      body: buildSubmitRequestBody({ sessionId: input.sessionId, output: draft.output }),
    });
    await completeSubmission(key, response);
    await postSlackAlert({
      kind: "submit_succeeded",
      title: "workflow submit succeeded",
      identifiers: { jobId: input.jobId, runId: policy.runId, sessionId: input.sessionId, wallet: session.wallet },
      details: {
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        draftId: input.draftId,
        outputHash,
        ...submitResponseDetails(response),
      },
    });
    return { response };
  } catch (error) {
    await failSubmission(key, error);
    await postSlackAlert({
      kind: "submit_failed",
      title: "workflow submit failed after mutation attempt",
      identifiers: { jobId: input.jobId, runId: policy.runId, sessionId: input.sessionId, wallet: session.wallet },
      details: {
        error: error instanceof Error ? error.message : String(error),
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        draftId: input.draftId,
        outputHash,
      },
    });
    throw error;
  }
}

async function fetchWikipediaEvidenceForWorkflow(definition: unknown, maxEvidenceUrls: number): Promise<WikipediaEvidenceBundle> {
  const pageTitle = readPageTitle(definition);
  const revisionId = readRevisionId(definition);
  if (!pageTitle || !revisionId) {
    throw new Error("wikipedia_definition_missing_page_title_or_revision_id");
  }
  const revision = await fetchWikipediaRevision({ title: pageTitle, revisionId, format: "references" });
  const citations = "references" in revision && Array.isArray(revision.references) ? revision.references : [];
  const urls = [...new Set(citations.flatMap((citation) => citation.urls).filter(Boolean))].slice(0, maxEvidenceUrls);
  const sourceChecks = [];
  for (const url of urls) {
    const check = await checkSourceUrl({ url }).catch((error) => ({
      url,
      ok: false,
      status: 0,
      finalUrl: url,
      error: error instanceof Error ? error.message : String(error),
    }));
    const archive = await findArchiveSnapshot({ url }).catch(() => undefined);
    sourceChecks.push({
      url,
      status: isRecord(check) && typeof check.status === "number" ? check.status : undefined,
      ok: isRecord(check) && typeof check.ok === "boolean" ? check.ok : undefined,
      finalUrl: isRecord(check) && typeof check.finalUrl === "string" ? check.finalUrl : url,
      archiveUrl: firstArchiveUrl(archive),
    });
  }
  return {
    pageTitle: revision.title,
    revisionId: revision.revisionId,
    revisionUrl: revision.revisionUrl,
    citations,
    sourceChecks,
  };
}

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
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${isRecord(payload) ? payload.message ?? "unknown_error" : "unknown_error"}`);
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

function firstArchiveUrl(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return null;
  const first = value.candidates.find(isRecord);
  return typeof first?.archiveUrl === "string" ? first.archiveUrl : null;
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

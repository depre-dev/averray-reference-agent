export type QueryFn = <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;

export type ClaimMutationPolicyConfig = {
  requireRunId: boolean;
  maxClaimAttempts: number;
  claimJobAllowlist: string[];
  allowFreshClaimRetry: boolean;
  failOpenOnPolicyStoreError: boolean;
};

export type SubmitMutationPolicyConfig = {
  requireRunId: boolean;
  maxSubmitAttempts: number;
  submitSessionAllowlist: string[];
  submitJobAllowlist: string[];
  allowSubmitRetry: boolean;
  failOpenOnPolicyStoreError: boolean;
};

export type ClaimMutationPolicyDecision = {
  allowed: boolean;
  reason: string | null;
  runId: string | null;
  jobId: string;
  idempotencyKey: string;
  maxClaimAttempts: number;
  previousAttempts: number;
  existingClaims: Array<{
    idempotencyKey: string;
    status: string | null;
    attempts: number;
  }>;
  audit: string;
};

export type SubmitMutationPolicyDecision = {
  allowed: boolean;
  reason: string | null;
  runId: string | null;
  sessionId: string;
  jobId: string | null;
  idempotencyKey: string;
  maxSubmitAttempts: number;
  previousAttempts: number;
  existingSubmits: Array<{
    idempotencyKey: string;
    status: string | null;
    attempts: number;
    sessionId: string | null;
    jobId: string | null;
  }>;
  audit: string;
};

type SubmissionRow = {
  idempotency_key: string;
  status: string | null;
  attempts: number | null;
  session_id?: string | null;
  job_id?: string | null;
};

export function loadClaimMutationPolicyConfig(env: NodeJS.ProcessEnv = process.env): ClaimMutationPolicyConfig {
  return {
    requireRunId: parseBoolean(env.AVERRAY_REQUIRE_CLAIM_RUN_ID, true),
    maxClaimAttempts: parsePositiveInt(env.AVERRAY_MAX_CLAIM_ATTEMPTS ?? env.MAX_CLAIM_ATTEMPTS, 1),
    claimJobAllowlist: parseCsv(env.AVERRAY_CLAIM_JOB_ALLOWLIST ?? env.CLAIM_JOB_ALLOWLIST),
    allowFreshClaimRetry: parseBoolean(env.AVERRAY_ALLOW_FRESH_CLAIM_RETRY, false),
    failOpenOnPolicyStoreError: parseBoolean(env.AVERRAY_MUTATION_POLICY_FAIL_OPEN, false)
  };
}

export function loadSubmitMutationPolicyConfig(env: NodeJS.ProcessEnv = process.env): SubmitMutationPolicyConfig {
  return {
    requireRunId: parseBoolean(env.AVERRAY_REQUIRE_SUBMIT_RUN_ID, true),
    maxSubmitAttempts: parsePositiveInt(env.AVERRAY_MAX_SUBMIT_ATTEMPTS ?? env.MAX_SUBMIT_ATTEMPTS, 1),
    submitSessionAllowlist: parseCsv(env.AVERRAY_SUBMIT_SESSION_ALLOWLIST ?? env.SUBMIT_SESSION_ALLOWLIST),
    submitJobAllowlist: parseCsv(env.AVERRAY_SUBMIT_JOB_ALLOWLIST ?? env.SUBMIT_JOB_ALLOWLIST),
    allowSubmitRetry: parseBoolean(env.AVERRAY_ALLOW_SUBMIT_RETRY, false),
    failOpenOnPolicyStoreError: parseBoolean(env.AVERRAY_MUTATION_POLICY_FAIL_OPEN, false)
  };
}

export async function evaluateClaimMutationPolicy(
  input: {
    runId?: string;
    jobId: string;
    idempotencyKey: string;
  },
  query: QueryFn,
  config: ClaimMutationPolicyConfig = loadClaimMutationPolicyConfig()
): Promise<ClaimMutationPolicyDecision> {
  const runId = normalizeRunId(input.runId);
  const baseDecision = {
    runId,
    jobId: input.jobId,
    idempotencyKey: input.idempotencyKey,
    maxClaimAttempts: config.maxClaimAttempts,
    previousAttempts: 0,
    existingClaims: []
  };

  if (config.requireRunId && !runId) {
    return blocked(baseDecision, "missing_run_id");
  }

  if (config.claimJobAllowlist.length > 0 && !config.claimJobAllowlist.includes(input.jobId)) {
    return blocked(baseDecision, "job_not_allowed");
  }

  let existingClaims: ClaimMutationPolicyDecision["existingClaims"];
  try {
    existingClaims = await loadExistingClaimAttempts(query, runId ?? "default");
  } catch (error) {
    if (config.failOpenOnPolicyStoreError) {
      return allowed({
        ...baseDecision,
        audit: `claim policy store unavailable; fail-open enabled: ${errorMessage(error)}`
      });
    }
    return blocked(baseDecision, "policy_store_unavailable");
  }

  const previousAttempts = existingClaims.reduce((total, claim) => total + Math.max(claim.attempts, 1), 0);
  const decisionBase = {
    ...baseDecision,
    previousAttempts,
    existingClaims
  };

  if (previousAttempts >= config.maxClaimAttempts) {
    return blocked(decisionBase, "max_claim_attempts_exceeded");
  }

  const hasPreviousClaim = existingClaims.length > 0;
  const isKnownIdempotencyKey = existingClaims.some((claim) => claim.idempotencyKey === input.idempotencyKey);
  if (hasPreviousClaim && !isKnownIdempotencyKey && !config.allowFreshClaimRetry) {
    return blocked(decisionBase, "fresh_idempotency_key_retry_blocked");
  }

  return allowed(decisionBase);
}

export async function evaluateSubmitMutationPolicy(
  input: {
    runId?: string;
    sessionId: string;
    jobId?: string;
    idempotencyKey: string;
  },
  query: QueryFn,
  config: SubmitMutationPolicyConfig = loadSubmitMutationPolicyConfig()
): Promise<SubmitMutationPolicyDecision> {
  const runId = normalizeRunId(input.runId);
  const jobId = normalizeOptional(input.jobId);
  const baseDecision = {
    runId,
    sessionId: input.sessionId,
    jobId,
    idempotencyKey: input.idempotencyKey,
    maxSubmitAttempts: config.maxSubmitAttempts,
    previousAttempts: 0,
    existingSubmits: []
  };

  if (config.requireRunId && !runId) {
    return blockedSubmit(baseDecision, "missing_run_id");
  }

  if (
    config.submitSessionAllowlist.length > 0
    && !config.submitSessionAllowlist.includes(input.sessionId)
  ) {
    return blockedSubmit(baseDecision, "session_not_allowed");
  }

  if (config.submitJobAllowlist.length > 0 && (!jobId || !config.submitJobAllowlist.includes(jobId))) {
    return blockedSubmit(baseDecision, "job_not_allowed");
  }

  let existingSubmits: SubmitMutationPolicyDecision["existingSubmits"];
  try {
    existingSubmits = await loadExistingSubmitAttempts(query, runId ?? "default");
  } catch (error) {
    if (config.failOpenOnPolicyStoreError) {
      return allowedSubmit({
        ...baseDecision,
        audit: `submit policy store unavailable; fail-open enabled: ${errorMessage(error)}`
      });
    }
    return blockedSubmit(baseDecision, "policy_store_unavailable");
  }

  const previousAttempts = existingSubmits.reduce((total, submit) => total + Math.max(submit.attempts, 1), 0);
  const decisionBase = {
    ...baseDecision,
    previousAttempts,
    existingSubmits
  };

  if (previousAttempts >= config.maxSubmitAttempts) {
    return blockedSubmit(decisionBase, "max_submit_attempts_exceeded");
  }

  if (existingSubmits.length > 0 && !config.allowSubmitRetry) {
    return blockedSubmit(decisionBase, "submit_retry_blocked");
  }

  return allowedSubmit(decisionBase);
}

export function isUuid(value: string | undefined): boolean {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function loadExistingClaimAttempts(query: QueryFn, runScope: string) {
  const rows = await query<SubmissionRow>(
    `select idempotency_key, status, attempts
     from submissions
     where kind = 'claim'
       and coalesce(run_id::text, request->>'policyRunId', request->>'runId', 'default') = $1
     order by created_at asc`,
    [runScope]
  );
  return rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts ?? 0
  }));
}

async function loadExistingSubmitAttempts(query: QueryFn, runScope: string) {
  const rows = await query<SubmissionRow>(
    `select idempotency_key, status, attempts, request->>'sessionId' as session_id, request->>'jobId' as job_id
     from submissions
     where kind = 'submit'
       and coalesce(run_id::text, request->>'policyRunId', request->>'runId', 'default') = $1
     order by created_at asc`,
    [runScope]
  );
  return rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts ?? 0,
    sessionId: row.session_id ?? null,
    jobId: row.job_id ?? null
  }));
}

function allowed(input: Omit<ClaimMutationPolicyDecision, "allowed" | "reason" | "audit"> & { audit?: string }) {
  return {
    ...input,
    allowed: true,
    reason: null,
    audit: input.audit ?? "claim mutation allowed by policy"
  };
}

function allowedSubmit(input: Omit<SubmitMutationPolicyDecision, "allowed" | "reason" | "audit"> & { audit?: string }) {
  return {
    ...input,
    allowed: true,
    reason: null,
    audit: input.audit ?? "submit mutation allowed by policy"
  };
}

function blocked(input: Omit<ClaimMutationPolicyDecision, "allowed" | "reason" | "audit">, reason: string) {
  return {
    ...input,
    allowed: false,
    reason,
    audit: `averray_claim blocked by mutation policy: ${reason}`
  };
}

function blockedSubmit(input: Omit<SubmitMutationPolicyDecision, "allowed" | "reason" | "audit">, reason: string) {
  return {
    ...input,
    allowed: false,
    reason,
    audit: `averray_submit blocked by mutation policy: ${reason}`
  };
}

function normalizeRunId(runId: string | undefined) {
  const value = runId?.trim();
  return value ? value : null;
}

function normalizeOptional(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type QueryFn = <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;

export type ClaimMutationPolicyConfig = {
  requireRunId: boolean;
  maxClaimAttempts: number;
  claimJobAllowlist: string[];
  allowFreshClaimRetry: boolean;
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

type SubmissionRow = {
  idempotency_key: string;
  status: string | null;
  attempts: number | null;
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

function allowed(input: Omit<ClaimMutationPolicyDecision, "allowed" | "reason" | "audit"> & { audit?: string }) {
  return {
    ...input,
    allowed: true,
    reason: null,
    audit: input.audit ?? "claim mutation allowed by policy"
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

function normalizeRunId(runId: string | undefined) {
  const value = runId?.trim();
  return value ? value : null;
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

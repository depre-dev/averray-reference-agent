import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { privateKeyToAccount } from "viem/accounts";
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
import {
  getDraftSubmission,
  listDraftSubmissions,
  markDraftValidation,
  normalizeDraftOutput,
  saveDraftSubmission,
  summarizeDraft,
  type DraftSubmission,
} from "./draft-submissions.js";
import {
  checkSourceUrl,
  extractWikipediaCitations,
  fetchWikipediaRevision,
  findArchiveSnapshot,
} from "./wiki-evidence.js";
import {
  readPageTitle,
  readRevisionId,
  runWikipediaCitationRepairWorkflow,
  type WikipediaEvidenceBundle,
  type WorkflowJob,
} from "./job-workflows.js";
import {
  getLastWikipediaCitationRepairStatus,
} from "./operator-commands.js";
import { handleOperatorCommandText } from "./operator-handler.js";

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

server.tool(
  "averray_fetch_wikipedia_revision",
  "Read-only helper for pinned Wikipedia revisions. Fetches an exact oldid through MediaWiki APIs and returns bounded wikitext/html, or parsed references. Does not edit Wikipedia and does not mutate Averray state.",
  {
    title: z.string().min(1),
    revisionId: z.string().min(1),
    format: z.enum(["wikitext", "html", "references"]).default("wikitext"),
    maxBytes: z.number().int().min(1_000).max(500_000).optional()
  },
  async ({ title, revisionId, format, maxBytes }) => {
    return jsonContent(await fetchWikipediaRevision({ title, revisionId, format, maxBytes }));
  }
);

server.tool(
  "averray_extract_wikipedia_citations",
  "Read-only helper that fetches a pinned Wikipedia revision and extracts structured citation/reference evidence: ref ids, citation template names, source URLs, archive URLs, dead-link markers, access dates, and bounded surrounding context.",
  {
    title: z.string().min(1),
    revisionId: z.string().min(1),
    maxCitations: z.number().int().min(1).max(200).default(80),
    maxContextChars: z.number().int().min(80).max(1_000).default(240)
  },
  async ({ title, revisionId, maxCitations, maxContextChars }) => {
    return jsonContent(await extractWikipediaCitations({ title, revisionId, maxCitations, maxContextChars }));
  }
);

server.tool(
  "averray_check_source_url",
  "Read-only helper for source URL evidence. Fetches a URL with redirects and timeout, returning status, final URL, content type, host match, archive hints, and a short safe title/snippet when text-like.",
  {
    url: z.string().url(),
    expectedHost: z.string().optional(),
    userAgent: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
    maxSnippetChars: z.number().int().min(0).max(2_000).default(280)
  },
  async ({ url, expectedHost, userAgent, timeoutMs, maxSnippetChars }) => {
    return jsonContent(await checkSourceUrl({ url, expectedHost, userAgent, timeoutMs, maxSnippetChars }));
  }
);

server.tool(
  "averray_find_archive_snapshot",
  "Read-only helper for Wayback evidence. Looks up an archived snapshot candidate for a source URL, optionally near a citation access/archive date hint. Does not fetch or edit Wikipedia.",
  {
    url: z.string().url(),
    timestampHint: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(30_000).optional()
  },
  async ({ url, timestampHint, timeoutMs }) => {
    return jsonContent(await findArchiveSnapshot({ url, timestampHint, timeoutMs }));
  }
);

server.tool(
  "averray_handle_operator_command",
  "Direct router for trusted Slack/operator/command-center messages. Use this for short commands like 'run one wikipedia citation repair if safe' and 'status last wikipedia citation repair' instead of sending them through a free-form Hermes prompt. Recognized run commands call averray_run_wikipedia_citation_repair directly; recognized status commands are read-only.",
  {
    text: z.string().min(1),
    source: z.enum(["slack", "operator", "command_center", "hermes"]).default("operator"),
    expectedWallet: z.string().optional(),
    defaultDryRun: z.boolean().default(false),
    maxEvidenceUrls: z.number().int().min(1).max(20).default(5),
    confidenceThreshold: z.number().min(0).max(1).default(0.7)
  },
  async ({ text, source, expectedWallet, defaultDryRun, maxEvidenceUrls, confidenceThreshold }) => {
    return jsonContent(await handleOperatorCommandText(
      { text, source, expectedWallet, defaultDryRun, maxEvidenceUrls, confidenceThreshold },
      { query, workflowDeps: workflowDeps() }
    ));
  }
);

server.tool(
  "averray_status_last_wikipedia_citation_repair",
  "Read-only status command for Slack/operator use. Returns the latest Wikipedia citation-repair runId, jobId, sessionId, submitted/failed state, draftId, and Slack permalink when available.",
  {},
  async () => {
    return jsonContent(await getLastWikipediaCitationRepairStatus(query));
  }
);

server.tool(
  "averray_run_wikipedia_citation_repair",
  "Preferred first tool for short operator intents like 'Run one Wikipedia citation repair if safe' or 'Run Wikipedia citation repair for <jobId> if safe'. Run the reference agent's safe Wikipedia citation-repair workflow from one short command. It uses the generic Averray lifecycle skeleton plus the Wikipedia citation-repair adapter: wallet check, job discovery/definition, claimability/policy checks, optional claim, deterministic read-only evidence gathering, draft persistence, local validation, and guarded submit. dryRun defaults to true and never calls claim or submit. Use this workflow before lower-level tools such as averray_list_jobs or averray_claim for Wikipedia citation-repair requests.",
  {
    runId: z.string().optional(),
    jobId: z.string().optional(),
    dryRun: z.boolean().default(true),
    expectedWallet: z.string().optional(),
    maxEvidenceUrls: z.number().int().min(1).max(20).default(5),
    confidenceThreshold: z.number().min(0).max(1).default(0.7)
  },
  async ({ runId, jobId, dryRun, expectedWallet, maxEvidenceUrls, confidenceThreshold }) => {
    return jsonContent(await runWikipediaCitationRepairWorkflow(
      { runId, jobId, dryRun, expectedWallet, maxEvidenceUrls, confidenceThreshold },
      workflowDeps()
    ));
  }
);

server.tool("averray_claim", "Low-level claim primitive for explicit claim operations. Do not use this directly for short Wikipedia citation-repair operator intents; prefer averray_run_wikipedia_citation_repair so runId generation, evidence helpers, draft persistence, validation, submit limits, and Slack alerts are handled together.", {
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
  "averray_save_draft_submission",
  "Persist a structured proposal object before local validation or submit. Use this once the proposal is assembled so an interrupted Hermes session can resume with the exact JSON object. Drafts are keyed by runId/jobId/sessionId, size-limited, secret-key scanned, and always marked proposal-only/no Wikipedia edit.",
  {
    runId: z.string().optional(),
    jobId: z.string().min(1),
    sessionId: z.string().optional(),
    output: z.unknown(),
    proposalOnly: z.boolean().default(true),
    noWikipediaEdit: z.boolean().default(true)
  },
  async ({ runId, jobId, sessionId, output, proposalOnly, noWikipediaEdit }) => {
    const draft = await saveDraftSubmission(
      { runId, jobId, sessionId, output, proposalOnly, noWikipediaEdit },
      query
    );
    return jsonContent({
      saved: true,
      draft: summarizeDraft(draft),
      note: "Load this draft with averray_get_draft_submission or pass draftId to averray_validate_submission/averray_submit after resume."
    });
  }
);

server.tool(
  "averray_get_draft_submission",
  "Load a previously persisted structured proposal object. Use this after Hermes resume instead of reconstructing JSON from chat history. If draftId plus jobId/sessionId/runId are supplied, mismatches fail closed.",
  {
    draftId: z.string().optional(),
    runId: z.string().optional(),
    jobId: z.string().optional(),
    sessionId: z.string().optional()
  },
  async ({ draftId, runId, jobId, sessionId }) => {
    const draft = await getDraftSubmission({ draftId, runId, jobId, sessionId }, query);
    return jsonContent({ draft: { ...summarizeDraft(draft), output: draft.output } });
  }
);

server.tool(
  "averray_list_draft_submissions",
  "List recent persisted draft submissions without returning the proposal body. Use this to recover draftId/runId/jobId/sessionId after interruption.",
  {
    runId: z.string().optional(),
    jobId: z.string().optional(),
    sessionId: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20)
  },
  async ({ runId, jobId, sessionId, limit }) => {
    const drafts = await listDraftSubmissions({ runId, jobId, sessionId, limit }, query);
    return jsonContent({ count: drafts.length, drafts });
  }
);

server.tool(
  "averray_validate_submission",
  "Validate a structured submission output locally against the job's output schema. Read-only — does NOT consume the submit attempt budget and never calls the backend. Save the proposal first with averray_save_draft_submission, or pass draftId/runId/sessionId so resume loads the exact object. Returns { valid, validator, errors[], message } where errors carry actionable JSON paths (e.g. citation_findings.0.citation_number is not allowed).",
  {
    runId: z.string().optional(),
    jobId: z.string().min(1),
    sessionId: z.string().optional(),
    draftId: z.string().optional(),
    output: z.unknown().optional()
  },
  async ({ runId, jobId, sessionId, draftId, output }) => {
    const resolved = await resolveSubmissionOutput({ runId, jobId, sessionId, draftId, output });
    const definition = await request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
    const validation = validateSubmissionLocally(definition, resolved.output);
    if (resolved.draft) {
      await markDraftValidation(resolved.draft.draftId, validation.valid, validation, query);
    }
    if (!validation.valid) {
      await postSlackAlert({
        kind: "submit_validation_failed",
        title: "local submission validation failed",
        identifiers: { jobId, runId, sessionId },
        details: {
          mutationBudgetConsumed: false,
          draftId: resolved.draft?.draftId,
          ...validationFailureDetails(validation),
          ...jobDefinitionDetails(definition),
        },
      });
    }
    return jsonContent({
      jobId,
      ...(resolved.warning ? { warning: resolved.warning } : {}),
      ...(resolved.draft ? { draft: summarizeDraft(resolved.draft) } : {}),
      ...validation
    });
  }
);

server.tool("averray_submit", "Submit work through Averray's public API fallback path. Runs the same local schema validation as averray_validate_submission BEFORE the mutation policy check, so an invalid payload (e.g. extra structured fields) is rejected without consuming the one-shot submit attempt.", {
  runId: z.string().optional(),
  sessionId: z.string().min(1),
  jobId: z.string().optional(),
  draftId: z.string().optional(),
  output: z.unknown().optional(),
  outputHash: z.string().optional()
}, async ({ runId, sessionId, jobId, draftId, output, outputHash }) => {
  await assertNoKillSwitch("averray_submit");
  const resolved = await resolveSubmissionOutput({ runId, jobId, sessionId, draftId, output });
  const effectiveJobId = jobId ?? resolved.draft?.jobId;
  const effectiveOutputHash = outputHash ?? resolved.draft?.outputHash ?? resolved.outputHash;

  // Pre-flight schema validation — runs BEFORE the mutation policy
  // check and BEFORE any HTTP call. The reference agent has
  // `maxSubmitAttempts=1`; without this gate a single field-shape
  // mistake (the citation_number bug from the reference run) burns
  // the only attempt and then `max_submit_attempts_exceeded` blocks
  // the corrected payload. We need a jobId to pull the right schema;
  // when the agent omits it (legacy path) we skip validation rather
  // than refusing the submit.
  if (typeof effectiveJobId === "string" && effectiveJobId.length > 0) {
    let definition: unknown;
    try {
      definition = await request(`/jobs/definition?jobId=${encodeURIComponent(effectiveJobId)}`);
    } catch (error) {
      // Couldn't reach the definition endpoint — surface the error to
      // the agent rather than silently skipping validation. The
      // mutation budget is untouched.
      await postSlackAlert({
        kind: "submit_blocked",
        title: "submit blocked before mutation",
        identifiers: { jobId: effectiveJobId, runId, sessionId },
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
    const validation = validateSubmissionLocally(definition, resolved.output);
    if (resolved.draft) {
      await markDraftValidation(resolved.draft.draftId, validation.valid, validation, query);
    }
    if (!validation.valid) {
      await postSlackAlert({
        kind: "submit_validation_failed",
        title: "local submission validation failed",
        identifiers: { jobId: effectiveJobId, runId, sessionId },
        details: {
          mutationBudgetConsumed: false,
          draftId: resolved.draft?.draftId,
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

  const key = idempotencyKey(["averray", runId ?? sessionId, "submit", effectiveOutputHash]);
  const policy = await evaluateSubmitMutationPolicy({ runId, sessionId, jobId: effectiveJobId, idempotencyKey: key }, query);
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
  await upsertSubmission({
    runId,
    kind: "submit",
    key,
    request: { sessionId, jobId: effectiveJobId, draftId: resolved.draft?.draftId, outputHash: effectiveOutputHash, policyRunId: policy.runId }
  });
  try {
    const response = await request("/jobs/submit", {
      method: "POST",
      token: session.token,
      body: buildSubmitRequestBody({ sessionId, output: resolved.output })
    });
    await completeSubmission(key, response);
    await postSlackAlert({
      kind: "submit_succeeded",
      title: "submit succeeded",
      identifiers: { jobId: effectiveJobId, runId: policy.runId, sessionId, wallet: session.wallet },
      details: {
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        draftId: resolved.draft?.draftId,
        outputHash: effectiveOutputHash,
        ...submitResponseDetails(response),
      },
    });
    return jsonContent({ idempotencyKey: key, policy, response });
  } catch (error) {
    await failSubmission(key, error);
    await postSlackAlert({
      kind: "submit_failed",
      title: "submit failed after mutation attempt",
      identifiers: { jobId: effectiveJobId, runId: policy.runId, sessionId, wallet: session.wallet },
      details: {
        error: error instanceof Error ? error.message : String(error),
        mutationBudgetConsumed: true,
        idempotencyKey: key,
        draftId: resolved.draft?.draftId,
        outputHash: effectiveOutputHash,
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

function workflowDeps() {
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
    async policyCheckClaim(input: {
      runId: string;
      jobId: string;
      taskType?: string;
      verifierMode?: string;
      rewardUsd: number;
    }) {
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
        details: policy
      };
    },
    async claim(input: { runId: string; jobId: string }) {
      return claimOnceForWorkflow(input);
    },
    async fetchEvidence(input: { definition: unknown; maxEvidenceUrls: number }): Promise<WikipediaEvidenceBundle> {
      return fetchWikipediaEvidenceForWorkflow(input.definition, input.maxEvidenceUrls);
    },
    async saveDraft(input: { runId: string; jobId: string; sessionId?: string; output: Record<string, unknown> }) {
      const draft = await saveDraftSubmission(
        { ...input, proposalOnly: true, noWikipediaEdit: true },
        query
      );
      return { draftId: draft.draftId, outputHash: draft.outputHash };
    },
    async validate(input: { runId: string; jobId: string; sessionId?: string; draftId?: string; output?: Record<string, unknown> }) {
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
    async submit(input: { runId: string; jobId: string; sessionId: string; draftId: string; outputHash?: string }) {
      return submitDraftOnceForWorkflow(input);
    }
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
      body: { jobId: input.jobId, idempotencyKey: key }
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
    idempotencyKey: key
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
    request: { sessionId: input.sessionId, jobId: input.jobId, draftId: input.draftId, outputHash, policyRunId: policy.runId }
  });
  try {
    const response = await request("/jobs/submit", {
      method: "POST",
      token: session.token,
      body: buildSubmitRequestBody({ sessionId: input.sessionId, output: draft.output })
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

function firstArchiveUrl(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return null;
  const first = value.candidates.find(isRecord);
  return typeof first?.archiveUrl === "string" ? first.archiveUrl : null;
}

async function resolveSubmissionOutput(input: {
  runId?: string;
  jobId?: string;
  sessionId?: string;
  draftId?: string;
  output?: unknown;
}): Promise<{
  output: Record<string, unknown>;
  outputHash: string;
  warning?: string;
  draft?: DraftSubmission;
}> {
  if (input.output !== undefined) {
    if (input.jobId && (input.runId || input.sessionId)) {
      const draft = await saveDraftSubmission(
        {
          runId: input.runId,
          jobId: input.jobId,
          sessionId: input.sessionId,
          output: input.output,
          proposalOnly: true,
          noWikipediaEdit: true
        },
        query
      );
      return { output: draft.output, outputHash: draft.outputHash, draft };
    }
    const normalized = normalizeDraftOutput(input.output);
    return {
      output: normalized.output,
      outputHash: normalized.outputHash,
      ...(normalized.warning ? { warning: normalized.warning } : {})
    };
  }

  const draft = await getDraftSubmission(
    {
      draftId: input.draftId,
      runId: input.runId,
      jobId: input.jobId,
      sessionId: input.sessionId
    },
    query
  );
  return { output: draft.output, outputHash: draft.outputHash, draft };
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

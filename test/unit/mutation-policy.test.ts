import { describe, expect, it } from "vitest";

import {
  evaluateClaimMutationPolicy,
  evaluateSubmitMutationPolicy,
  isUuid,
  loadClaimMutationPolicyConfig,
  loadSubmitMutationPolicyConfig,
  type QueryFn
} from "../../packages/averray-mcp/src/mutation-policy.js";

describe("claim mutation policy", () => {
  it("requires an explicit run id by default", async () => {
    const decision = await evaluateClaimMutationPolicy(
      { jobId: "job-1", idempotencyKey: "claim-1" },
      rows([])
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing_run_id");
    expect(decision.audit).toContain("averray_claim blocked");
  });

  it("blocks jobs outside the configured allowlist", async () => {
    const decision = await evaluateClaimMutationPolicy(
      { runId: "run-1", jobId: "job-2", idempotencyKey: "claim-1" },
      rows([]),
      loadClaimMutationPolicyConfig({
        AVERRAY_CLAIM_JOB_ALLOWLIST: "job-1",
        AVERRAY_REQUIRE_CLAIM_RUN_ID: "true"
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("job_not_allowed");
  });

  it("allows the first claim attempt for a run", async () => {
    const decision = await evaluateClaimMutationPolicy(
      { runId: "run-1", jobId: "job-1", idempotencyKey: "claim-1" },
      rows([])
    );

    expect(decision.allowed).toBe(true);
    expect(decision.previousAttempts).toBe(0);
  });

  it("blocks a second claim after the first response failed", async () => {
    const decision = await evaluateClaimMutationPolicy(
      { runId: "run-1", jobId: "job-1", idempotencyKey: "claim-2" },
      rows([{ idempotency_key: "claim-1", status: "failed", attempts: 1 }])
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("max_claim_attempts_exceeded");
    expect(decision.previousAttempts).toBe(1);
  });

  it("blocks a fresh idempotency key retry unless explicitly enabled", async () => {
    const decision = await evaluateClaimMutationPolicy(
      { runId: "run-1", jobId: "job-1", idempotencyKey: "claim-2" },
      rows([{ idempotency_key: "claim-1", status: "failed", attempts: 1 }]),
      loadClaimMutationPolicyConfig({
        AVERRAY_REQUIRE_CLAIM_RUN_ID: "true",
        AVERRAY_MAX_CLAIM_ATTEMPTS: "2",
        AVERRAY_ALLOW_FRESH_CLAIM_RETRY: "false"
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("fresh_idempotency_key_retry_blocked");
  });

  it("fails closed when the policy store cannot be read", async () => {
    const failingQuery: QueryFn = async () => {
      throw new Error("database unavailable");
    };
    const decision = await evaluateClaimMutationPolicy(
      { runId: "run-1", jobId: "job-1", idempotencyKey: "claim-1" },
      failingQuery
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("policy_store_unavailable");
  });

  it("recognizes UUID run ids for the submissions table foreign key", () => {
    expect(isUuid("019dc651-ea39-7cd1-a933-8181b4017d2f")).toBe(true);
    expect(isUuid("run-1")).toBe(false);
  });
});

describe("submit mutation policy", () => {
  const intendedSessionId = "wiki-en-58158792-citation-repair:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05";
  const mistypedSessionId = "wiki-en-58158792-citation-repair:0x30BC468dA4E95a8FA4b3f2048c86687a57CdeE05";

  it("requires an explicit run id by default", async () => {
    const decision = await evaluateSubmitMutationPolicy(
      { sessionId: intendedSessionId, jobId: "wiki-en-58158792-citation-repair", idempotencyKey: "submit-1" },
      rows([])
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing_run_id");
    expect(decision.audit).toContain("averray_submit blocked");
  });

  it("blocks a one-character session id typo before the network call", async () => {
    const decision = await evaluateSubmitMutationPolicy(
      {
        runId: "controlled-wikipedia-claim-001",
        sessionId: mistypedSessionId,
        jobId: "wiki-en-58158792-citation-repair",
        idempotencyKey: "submit-1"
      },
      rows([]),
      loadSubmitMutationPolicyConfig({
        AVERRAY_REQUIRE_SUBMIT_RUN_ID: "true",
        AVERRAY_SUBMIT_SESSION_ALLOWLIST: intendedSessionId
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("session_not_allowed");
    expect(decision.sessionId).toBe(mistypedSessionId);
  });

  it("blocks jobs outside the configured submit allowlist", async () => {
    const decision = await evaluateSubmitMutationPolicy(
      {
        runId: "controlled-wikipedia-claim-001",
        sessionId: intendedSessionId,
        jobId: "wiki-en-other",
        idempotencyKey: "submit-1"
      },
      rows([]),
      loadSubmitMutationPolicyConfig({
        AVERRAY_REQUIRE_SUBMIT_RUN_ID: "true",
        AVERRAY_SUBMIT_JOB_ALLOWLIST: "wiki-en-58158792-citation-repair"
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("job_not_allowed");
  });

  it("allows the first submit attempt for a run", async () => {
    const decision = await evaluateSubmitMutationPolicy(
      {
        runId: "controlled-wikipedia-claim-001",
        sessionId: intendedSessionId,
        jobId: "wiki-en-58158792-citation-repair",
        idempotencyKey: "submit-1"
      },
      rows([])
    );

    expect(decision.allowed).toBe(true);
    expect(decision.previousAttempts).toBe(0);
  });

  it("blocks a second submit after the first transport failure", async () => {
    const decision = await evaluateSubmitMutationPolicy(
      {
        runId: "controlled-wikipedia-claim-001",
        sessionId: intendedSessionId,
        jobId: "wiki-en-58158792-citation-repair",
        idempotencyKey: "submit-2"
      },
      rows([{
        idempotency_key: "submit-1",
        status: "failed",
        attempts: 1,
        session_id: intendedSessionId,
        job_id: "wiki-en-58158792-citation-repair"
      }])
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("max_submit_attempts_exceeded");
    expect(decision.previousAttempts).toBe(1);
  });

  it("blocks retry even under a larger budget unless retries are explicitly enabled", async () => {
    const decision = await evaluateSubmitMutationPolicy(
      {
        runId: "controlled-wikipedia-claim-001",
        sessionId: intendedSessionId,
        jobId: "wiki-en-58158792-citation-repair",
        idempotencyKey: "submit-2"
      },
      rows([{
        idempotency_key: "submit-1",
        status: "failed",
        attempts: 1,
        session_id: intendedSessionId,
        job_id: "wiki-en-58158792-citation-repair"
      }]),
      loadSubmitMutationPolicyConfig({
        AVERRAY_REQUIRE_SUBMIT_RUN_ID: "true",
        AVERRAY_MAX_SUBMIT_ATTEMPTS: "2",
        AVERRAY_ALLOW_SUBMIT_RETRY: "false"
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("submit_retry_blocked");
  });

  it("fails closed when the submit policy store cannot be read", async () => {
    const failingQuery: QueryFn = async () => {
      throw new Error("database unavailable");
    };
    const decision = await evaluateSubmitMutationPolicy(
      {
        runId: "controlled-wikipedia-claim-001",
        sessionId: intendedSessionId,
        jobId: "wiki-en-58158792-citation-repair",
        idempotencyKey: "submit-1"
      },
      failingQuery
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("policy_store_unavailable");
  });
});

function rows(output: Array<{ idempotency_key: string; status: string; attempts: number }>): QueryFn {
  return async () => output;
}

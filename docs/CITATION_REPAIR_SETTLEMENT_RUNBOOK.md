# Citation-repair settlement runbook (gold path)

**Audience:** operator. **Scope:** taking ONE Wikipedia citation-repair proposal
from dry-run analysis through a real **claim + submit** on the Averray platform.

> **Read this first — the truth boundary.** Everything in the board loop
> (launcher → mission card → Hermes verdict → self-healing fix → re-run) is
> **`dryRun` only**: it analyzes, it never claims or submits. `dryRun` defaults
> to `true` everywhere (`job-workflows.ts:157`; the MCP tool schema
> `index.ts:416`; the operator NL command suggests *"run one wikipedia citation
> repair **dry run only**"*). Real settlement is **not** part of any automated
> loop and is **not** wired into autopilot. It is a deliberate, one-at-a-time,
> human-run step — this document — and it **moves real value and is not
> reversible**. There is no "undo submit". The gates below ARE the safety; the
> procedure exists so you trip none of them by accident.

This runbook is for the moment an adapter fix has landed and a fresh **dry run
goes green** (a coherent, schema-valid proposal that actually repairs the dead
links, at confidence ≥ the threshold). Until then, do not settle.

---

## 1. When to settle (entry criteria)

Settle a job ONLY when **all** of these hold:

1. **The adapter fix is merged.** The defect that produced garbled / missed /
   non-applyable proposals (`packages/averray-mcp/src/wiki-evidence.ts`,
   `packages/averray-mcp/src/job-workflows.ts`) is fixed on the running build.
2. **A fresh dry run for that exact `jobId` is green.** Run the dry run first
   (§3 step 1) and confirm the proposal:
   - reports the real dead-link citations (not `deadLinkCitations: 0` on a
     dead-link job),
   - has coherent `current_claim` / `target_text` (no mid-`<ref>` slices),
   - proposes applyable wikitext (not prose), and does not flag live sources as
     `weak_source`,
   - reports `confidence ≥ 0.7` (the default `confidenceThreshold`).
   In board terms: Hermes's disposition is **PASS** (or a clean **needs_review**
   you have personally reviewed), **not FAIL**.
3. **You have eyes on the proposal.** You have read the `proposalPreview`
   (`citation_findings` + `proposed_changes`) in the mission-card drawer and you
   would make this edit yourself.
4. **Kill-switch is OFF and you intend exactly one submit.** Submit is one-shot
   (§2) — there is no second attempt and no rollback.

If any criterion is unmet: **stop**. Re-run the dry run, or send the defect back
through the self-healing loop. Never settle to "create work" or to force a green.

---

## 2. The safety model (what gates a real submit)

These exist in code today; the procedure is built around them. (Sources cited so
you can audit, not invent.)

| Gate | Where | Default / behavior |
|---|---|---|
| `dryRun` opt-in | `job-workflows.ts:157`, `index.ts:416` | **`true`** — a real submit requires explicitly passing `dryRun: false`. |
| Kill-switch (HALT) | `default-workflow-runtime.ts:120,189` (`assertNoKillSwitch("averray_claim")` / `("averray_submit")`) | If the global kill-switch / HALT is active, claim and submit throw. |
| `expectedWallet` | `job-workflows.ts:180–181` | If provided and it does not match the configured signer, returns `blocked` / `wallet_mismatch` — **always pass it** (§3). |
| Schema validation before claim | `job-workflows.ts` (direct-submission validate + invalid-wrapper probe) | Both must pass **before** the claim is attempted; fails closed. |
| Confidence threshold | `job-workflows.ts:159,417` | `confidenceThreshold` default `0.7`; below it → `needs_review`, **no submit**. |
| Claim policy | `mutation-policy.ts:66–67` | `AVERRAY_MAX_CLAIM_ATTEMPTS` (default **1**); optional `AVERRAY_CLAIM_JOB_ALLOWLIST`. |
| Submit policy | `mutation-policy.ts:76,78` | `AVERRAY_MAX_SUBMIT_ATTEMPTS` (default **1** — one-shot); optional `AVERRAY_SUBMIT_JOB_ALLOWLIST`. |

**Order of operations** (`runWikipediaCitationRepairWorkflow`): wallet check →
`expectedWallet` match → job discovery/claimability → claim policy → evidence
fetch → schema validation (both probes) → **[if `dryRun:false`]** claim → save
draft → local validate → confidence gate → submit → submit policy. The first
seven steps run in a dry run too — so a green dry run has already exercised every
pre-claim gate.

---

## 3. The procedure

### Pre-flight checklist

- [ ] Entry criteria in §1 all met.
- [ ] `AGENT_WALLET_PRIVATE_KEY` is set to the **intended settlement signer** on
      the running process (`default-workflow-runtime.ts:53`). You know the
      address it derives to.
- [ ] `AVERRAY_API_BASE_URL` points at the intended environment
      (`default-workflow-runtime.ts:34`, default `https://api.averray.com`).
- [ ] Kill-switch is OFF (no active global kill-switch / HALT).
- [ ] (Recommended) `AVERRAY_SUBMIT_JOB_ALLOWLIST` / `AVERRAY_CLAIM_JOB_ALLOWLIST`
      contain **only** the one `jobId` you are about to settle — so a stray run
      cannot submit anything else.
- [ ] You have the exact `jobId` and the expected wallet address to hand.

### Step 1 — Dry run, and read it

Run a dry run for the exact job and confirm it is green (§1.2). On the board:
launch **Citation Repair** with the Job ID (read-only), or via the operator
command *"run one wikipedia citation repair dry run only"*. Inspect the card's
verdict + proposal preview.

> Do not proceed unless this is green and you have read the proposal.

### Step 2 — Settle (the one real call)

Real settlement is the MCP tool **`averray_run_wikipedia_citation_repair`**
(`index.ts:411`) invoked with `dryRun: false`. There is **no CLI / npm script /
board button** for this — it is intentionally a deliberate tool call, and the
operator NL command only ever does a dry run. Invoke it with:

```jsonc
// averray_run_wikipedia_citation_repair
{
  "jobId": "<the exact jobId from the green dry run>",
  "dryRun": false,                       // REAL claim + submit — explicit opt-in
  "expectedWallet": "0x<intended signer address>",  // safety: must match the configured wallet
  "confidenceThreshold": 0.7             // optional; the default
}
```

- `expectedWallet` is **not optional in practice** — always pass it. A mismatch
  returns `blocked` / `wallet_mismatch` and nothing is claimed.
- The tool generates the `runId`, fetches evidence, validates, claims, drafts,
  re-validates, gates on confidence, and submits — all in one call, gated as in §2.

### Step 3 — Verify the outcome

Read the result `status` (`WorkflowStatus`):

| `status` | Meaning | Action |
|---|---|---|
| `submitted` | Claim + submit succeeded (`job-workflows.ts:452`). | Done — record it (§4). The proposal is now an Averray submission. |
| `needs_review` | Stopped at the confidence gate (`confidence_below_threshold`) or returned a reviewable proposal. | Do **not** retry blindly — the proposal wasn't strong enough. Re-review / send back to the loop. |
| `blocked` | A gate refused: `wallet_mismatch`, claim/submit policy, kill-switch, or a submit rejected by policy. | Read `reason`. Fix the cause (wrong wallet, allowlist, kill-switch, attempts exhausted). Do not force. |
| `no_submit` / `failed` | No submit was made / the run errored. | Inspect; nothing settled. Safe to diagnose. |

Confirm independently on the Averray platform that the submission landed as
expected.

### Step 4 — Record

Note the `jobId`, the `runId` from the result, the resulting `status`, and the
wallet address in your operations log (and the board card / Slack if configured
via `SLACK_WEBHOOK_URL`). One job = one settlement.

---

## 4. Abort / failure handling

- **Before Step 2:** abort costs nothing — just don't make the call.
- **A submit is one-shot and not reversible.** There is no automated rollback. If
  something looks wrong mid-procedure, the lever is the **kill-switch**: with it
  active, `averray_claim` and `averray_submit` throw, so no further claim/submit
  can occur. `AVERRAY_MAX_SUBMIT_ATTEMPTS` (default 1) already prevents a second
  submit.
- **If a submit landed in error:** this is a platform/Wikipedia-side correction,
  not a code rollback — handle it through the Averray platform's own dispute /
  correction process. Do not attempt to "re-submit a fix" through this tool
  without operator review.

---

## 5. Status check

To read the last citation-repair run without mutating anything, use the operator
command **"status last wikipedia citation repair"**
(`operator-handler.ts:51`) — read-only.

---

## Appendix — environment reference

| Env var | Source | Purpose / default |
|---|---|---|
| `AGENT_WALLET_PRIVATE_KEY` | `default-workflow-runtime.ts:53` | Settlement signer key; derives the wallet address. |
| `AVERRAY_API_BASE_URL` | `default-workflow-runtime.ts:34` | Averray platform base URL (default `https://api.averray.com`). |
| `AVERRAY_MAX_CLAIM_ATTEMPTS` | `mutation-policy.ts:66` | Max claim attempts (default `1`). |
| `AVERRAY_CLAIM_JOB_ALLOWLIST` | `mutation-policy.ts:67` | CSV of claimable jobIds (if set, only these). |
| `AVERRAY_MAX_SUBMIT_ATTEMPTS` | `mutation-policy.ts:76` | Max submit attempts (default `1` — one-shot). |
| `AVERRAY_SUBMIT_JOB_ALLOWLIST` | `mutation-policy.ts:78` | CSV of submittable jobIds (if set, only these). |
| `SLACK_WEBHOOK_URL` | (optional) | If set, claim/submit results post to Slack. |

**Boundary restated:** the board loop never settles; settlement is this manual,
gated, one-shot procedure. Keep it that way unless a separate, reviewed change
deliberately moves settlement elsewhere.

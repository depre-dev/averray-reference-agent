# INT-2 handback — verified green-path ceremony

**Status:** implementation and clean-checkout gates complete; independent review and live operator ceremony pending

**Baseline:** `720165cc5c44ea6c1c8fb6814b76a1ba7a2615ab`

**Implementation commit:** `8403bcaf28f425d2a117e1611c5f9df8b50d6237`

**Runtime authority change:** none; the new scripted turn uses the already-approved
`fs.write_file` grant inside the existing path allowlist

## Built

- Added the sibling `lint-format-green` ceremony proposal. The existing
  `lint-format` proposal and the pinned kernel's `finish.jsonl` remain
  byte-unchanged, so §2.5's negative proof is preserved.
- Added a committed deterministic two-turn model script. It writes one new
  file under `docs/**`, makes no network or external call, and stays within the
  existing 60-second, 8,000-token, and 30-tool-call budget.
- Kept the acceptance fence unchanged: the only required command remains
  `git diff --check`.
- Added the sibling fixture to the pilot CLI allowlist and help.
- Made the positive handoff's immutable decision record carry the evaluated
  eligibility value and predicate reason without adding a third decision:
  - `verified_handoff_ready_for_operator`
  - `eligible_for_pr_open=true`
  - `eligible_for_pr_open_reason=completed_outcome_verified_acceptance_all_checks_passed`
- Preserved exactly one handoff decision. Its `proposal.evidenceRefs` contains
  every `VerifiedHandoff.verification.evidenceRefs` entry, and it remains
  explicitly non-mutating.
- Strengthened reconciliation coverage for the handoff's non-empty patch ref,
  consistent manifest ref/hash, absent pull-request field, exact handoff
  decision count, eligibility evidence, and verification evidence refs.
- Kept the existing dispatch test that pins exactly one
  `dispatch_approval` / `dispatch_succeeded` decision for a successful
  dispatch. Together, the green path produces the architect-confirmed two
  records: one dispatch approval and one handoff.
- Added runbook §2.6. It copies the committed script beneath
  `CEREMONY_ROOT`, retains Harness commit `be55b34`, requires both the §2.5
  negative and §2.6 positive proofs, materializes and inspects the patch,
  checks the manifest, records evidence refs and eligibility, enforces the
  exact claim/outbox/decision counts, and forbids PR/GitHub actuation.

No Harness kernel, Harness pin, profile, capability list, acceptance
criterion, schema, migration, database, wallet, settlement, deploy, dependency,
lockfile, or existing ceremony fixture changed.

## Exact scripted model

Committed as
`test/fixtures/agent-integration/ceremony/lint-format-green.jsonl`.
SHA-256: `71389a0ad18a2fc756d1b238a2b6bf73d621afa734122c965acc800715236c5a`.

```jsonl
{"tool_calls":[{"id":"int2-green-write","name":"fs_write_file","arguments":{"path":"docs/harness-int2-green-path-proof.md","content":"# INT-2 green-path proof\n\nThis deterministic change verifies the supervised handoff path.\n"}}],"usage":{"input_tokens":2,"output_tokens":1,"requests":1},"finish_reason":"tool_call"}
{"text":"Wrote the deterministic allowlisted proof file.","usage":{"input_tokens":2,"output_tokens":2,"requests":1},"finish_reason":"stop"}
```

The script contract test parses both lines and pins the complete objects. It
also asserts exactly two turns, one `fs_write_file` call, an allowlisted path,
a trailing newline, no trailing whitespace, no space-before-tab, and the
unchanged acceptance command and budget.

## Deterministic resulting patch

The script output was materialized byte-for-byte in a disposable Git
repository. `git diff --check` passed. The patch SHA-256 is
`bf8cfa329e9fdd6d7e75da6c4688e28f9dab4c6d9c22410572a37d89bad847a9`;
the new file SHA-256 is
`3f5aa31bf3a3e0ce4043e46b43a9f4d460c734ff59821554d1ba56cc16514bb2`.

```diff
diff --git a/docs/harness-int2-green-path-proof.md b/docs/harness-int2-green-path-proof.md
new file mode 100644
index 0000000..79672fc
--- /dev/null
+++ b/docs/harness-int2-green-path-proof.md
@@ -0,0 +1,3 @@
+# INT-2 green-path proof
+
+This deterministic change verifies the supervised handoff path.
```

Only `docs/harness-int2-green-path-proof.md` is touched.

## Handoff result and non-actuation proof

For the completed, verification-passed projection pinned by the unit fixture:

```text
AgentTask.lifecycle=handoff_ready
VerifiedHandoff.outcome=completed
VerifiedHandoff.verification.decision=accept
VerifiedHandoff.verification.verified=true
VerifiedHandoff.eligibleForPrOpen=true
eligibility reason=completed_outcome_verified_acceptance_all_checks_passed
VerifiedHandoff.pullRequest=absent
handoff decision effects.mutates=false
handoff decision effects.mutations=[]
```

`eligibleForPrOpen=true` follows only from a completed outcome, verified
acceptance, and all recorded checks passing. It is evidence for later operator
review, not actuation authority. The reconciliation source fence still asserts
that the module has no submit, approve, deny, release, pull-request-open,
platform-claim, platform-submit, or GitHub-client call.

No live ceremony was executed during implementation: it requires the
operator-pinned local image and disposable control plane described by the
runbook. Therefore this handback does not claim a live `handoff_ready` result.
It records the exact deterministic input/output and the locally asserted
handoff result; the operator ceremony will capture real artifact refs, the one
attempt/claim/outbox rows, and both immutable decisions. No ceremony-path
GitHub mutation occurred.

## Affected surfaces

- Ceremony fixtures and pilot CLI: yes
- Dispatcher handoff decision evidence: yes
- Dispatcher and proposal unit tests: yes
- INT-2 ceremony runbook: yes
- Harness kernel or pin: unchanged
- Existing negative ceremony fixture: unchanged
- Schema, migration, database, ops/compose, secrets/config: unchanged
- Wallet, settlement, deploy, PR opening, GitHub mutation: unchanged

## Rollout and rollback

Rollout is the normal dispatcher image deployment after human merge and CI.
There is no migration or environment change. The committed script is copied
to the disposable ceremony root only when the operator explicitly runs §2.6.

Rollback reverts implementation commit `8403bca`. It removes the sibling
fixture, eligibility-reason audit fields, tests, and runbook case. No data,
database, secret, image, or external-state rollback is required.

## Clean-checkout verification

The definitive gates ran from detached clean checkout
`/private/tmp/averray-reference-agent-int2-green-path-clean` at implementation
commit `8403bca`.

```text
$ node --version
v25.5.0

$ npm --version
11.8.0

$ git status --porcelain
# no output

$ npm ci
added 312 packages, and audited 325 packages in 3s
# exit 0

$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm test
Test Files  194 passed | 1 skipped (195)
Tests       2417 passed | 4 skipped (2421)
Duration    10.57s
# exit 0

$ npm run build
> tsc -b packages/* services/*
# exit 0

$ git status --porcelain
# no output
```

Focused proof before the definitive clean gate:

```text
$ npm exec -- vitest run test/unit/agent-task-proposal.test.ts \
    test/unit/harness-pilot-cli.test.ts \
    test/unit/reconcile-run.test.ts \
    test/unit/dispatch-attempt.test.ts
Test Files  4 passed (4)
Tests       117 passed (117)
# exit 0
```

The four skipped tests require `HARNESS_TEST_DATABASE_URL`; this change adds no
database behavior or migration. Docker/compose validation was not run because
the PR changes no `ops/`, Dockerfile, Compose, environment, image-build, or
deployment surface. CI remains the Docker build and compose-config merge gate.

## Decisions and rationale

1. **Use a sibling fixture.** This keeps the legitimate no-write failure proof
   reproducible and gives the positive proof its own immutable identity.
2. **Commit the script with the fixture, then copy it under `CEREMONY_ROOT`.**
   The repository pins reviewed bytes while the runtime still receives the
   environment path required by the pinned Harness.
3. **Write one new allowlisted document.** A new file makes the patch
   deterministic against the pinned base and avoids depending on unrelated
   prose bytes while still exercising the real filesystem tool and verifier.
4. **Keep `git diff --check` unchanged.** The green result comes from a correct
   deterministic change, not a relaxed acceptance criterion.
5. **Record eligibility in the existing handoff decision's reasons.** The V2
   decision schema has no dedicated eligibility-result field. Adding the value
   and stable predicate reason to `proposal.why` makes them durable and
   queryable without widening the schema or creating an incorrect third
   decision.
6. **Carry verification refs through the handoff decision.** This uses the
   existing evidence-ref contract and lets the live bundle prove what was
   verified rather than only counting records.
7. **Keep eligibility non-actuating.** The handoff record is non-mutating, has
   no pull-request field, and sends the next action to the operator.

## Open questions

None for implementation. The live §2.6 operator ceremony remains the acceptance
step and must be recorded alongside the preserved §2.5 negative proof.

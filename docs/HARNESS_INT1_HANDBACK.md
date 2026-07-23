# INT-1 handback — read-only Harness projection

**Status:** implementation complete; pending review and live-pilot proof

**Branch:** `codex/harness-int1-projection`

**Baseline:** `3e559b85d99219ef3dc9ff174f30e9275af92512` (`origin/main`, merged INT-0)

**Runtime authority change:** read-only observation only, off by default

## Built

- Added a strict, secret-free pilot registry for immutable
  `workItemId` / `correlationId` / `harnessRunId` bindings.
- The registry pins final manifest metadata that the current generic Harness
  CLI does not expose through `run status`, including profile, risk class,
  effective capabilities, network policy, policy/verifier hashes, model
  bindings, skill versions, and budget limits.
- Added a fixed-argv CLI adapter that permits only:
  - `harness run status <known-run-id>`;
  - `harness run events <known-run-id>`;
  - `harness run deliverables <known-terminal-run-id>`.
- The adapter uses no shell interpolation, applies a timeout and combined output
  cap, validates run identity/state/event vocabulary, parses immutable artifact
  references, and does not surface raw stderr credentials.
- Added a deterministic mapper into the shared `AgentRunProjection` V1
  contract. It reports:
  - source health and staleness;
  - run state, attempt, terminal outcome, and failure;
  - pinned manifest identity and effective authority;
  - elapsed/model/tool usage derived from status/events;
  - verification status and report hash;
  - immutable deliverable artifacts;
  - Harness/Averray/PR bindings when present.
- Correlated projections join the existing monitor board by work item or
  correlation ID. A legacy item and Harness projection cannot produce duplicate
  cards; once a PR exists, GitHub remains lane-authoritative and the Harness
  facts attach to that card.
- Source denial, malformed/unknown output, stale reads, and manifest mismatches
  become degraded/attention state. They never reuse or extend a healthy signal.
- Added an explicit Harness tag, structured card progress, a manifest/budget/
  artifact drawer, and a read-only authority notice.
- Renamed visible shared-lane copy to **Work queue** while preserving the
  internal `codex-needed` lane ID and existing API/card compatibility.
- Hermes narration receives only bounded structured Harness facts. It does not
  receive raw event payloads or model messages, and Harness never speaks in the
  collaboration channel.

## Feature configuration

The path is a no-op unless explicitly enabled:

```text
HARNESS_PROJECTION_ENABLED=false
```

When an operator is ready to run the live pilot, configure:

```text
HARNESS_PROJECTION_ENABLED=true
HARNESS_PROJECTION_BINDINGS_PATH=/run/secrets-free-config/harness-run-registry.json
HARNESS_CLI_COMMAND=harness
HARNESS_PROJECTION_READ_TIMEOUT_MS=5000
```

`HARNESS_PROJECTION_BINDINGS_PATH` is configuration, not a secret. Its schema is
demonstrated by `test/fixtures/harness-integration/pilot-registry-v1.json`.
The Harness CLI's own data-source credential remains runtime secret material and
must not be copied into that file, logs, prompts, or the board.

## Safety pins

1. The registry rejects unknown versions, undeclared fields, duplicate work,
   correlation, or run identities, and secret-like keys/values.
2. Every CLI invocation is generated from a fixed read-only verb plus a
   schema-validated allowlisted run ID.
3. No submit, approve, deny, cancel, release, artifact-content, skill, wallet,
   GitHub-write, Averray-mutation, or dispatch command exists in the adapter.
4. Unknown Harness states or event types fail visibly rather than being coerced
   into current state.
5. The live egress policy, compiled risk class, and observed model role/ref must
   agree with the pinned manifest when the CLI exposes them.
6. Terminal deliverables are content-addressed references only; INT-1 does not
   read artifact contents.
7. Failed and quarantined records require structured failure detail.
8. The same status/event/deliverable inputs and observation time produce the
   same projection.
9. Harness cards have no dispatch, retry, approval, merge, or send-back control.
   “Ask Hermes” remains advisory.
10. The flag defaults off and no `HARNESS_DISPATCH_ENABLED` path exists.

## Live-pilot proof still required

This development environment had no `HARNESS_DATABASE_URL`, Harness CLI
executable, or operator-selected immutable pilot IDs. The included successful,
failed, and quarantined fixtures validate the current generic CLI grammar and
projection behavior, but they are not claimed as production run evidence.

Before INT-1 is accepted for rollout, an operator must:

1. create/select one real successful and one real failed bounded Harness run;
2. record their immutable IDs and final manifest pins in a secret-free registry;
3. enable the flag in a non-production or supervised pilot environment;
4. capture the board proof for both cards;
5. deny/stop the read source once and confirm the card becomes degraded rather
   than healthy;
6. disable the flag after the proof unless the operator explicitly approves the
   continued read-only pilot.

This is a rollout proof, not a reason to add a dispatcher or broaden authority.

## Affected surfaces

- Shared schema package: exported manifest projection schema only; V1 wire shape
  unchanged
- Slack operator: read-only Harness registry/CLI/projection source
- Monitor board and Hermes narration: yes
- Monitor UI: Harness facts and visible Work queue copy
- Tests/fixtures/docs/working agreement: yes
- Existing Codex/Claude runners and task queue: unchanged
- Policy allowlists and budgets: unchanged
- Ops/compose/environment files: unchanged
- GitHub/Averray/wallet/settlement/deploy mutation paths: unchanged
- Generic Agent Harness repository: unchanged

## Dependencies

The monitor UI and Slack operator now declare the existing workspace
`@avg/schemas` package directly. The Slack operator also declares the repository's
existing `zod` version directly because it validates the pilot registry. No new
third-party package or lifecycle script was introduced.

## Rollback

Set `HARNESS_PROJECTION_ENABLED=false` for immediate rollback. The default-off
code path performs no registry read and starts no Harness CLI process.

Code rollback removes the three `harness-*` Slack-operator modules, monitor/UI
projection fields and presentation, the direct workspace dependencies, fixtures,
tests, and this handback. No stored data, migration, external mutation, or
Harness run needs reversal. The internal `codex-needed` lane ID never changed.

## Verification

```text
$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm test
Test Files  177 passed (177)
Tests       2192 passed (2192)

$ npm run build
> tsc -b packages/* services/*
# exit 0
```

The first sandboxed full-suite attempt completed typecheck and 2,187 tests but
the sandbox denied loopback binding for the two existing test-wallet-signer HTTP
tests. After correcting one new test expectation, the final full suite was
rerun with loopback permission and passed 2,192/2,192.

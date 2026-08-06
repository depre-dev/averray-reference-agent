# INT-4 failure-drill ledger

This is the acceptance ledger defined by
`docs/HARNESS_INT4_CHARTER.md`. A mechanism is not treated as proven until a
disposable-environment drill has been observed red without it and green with
it. Rows are amended with dated evidence; an implementation alone never
silently upgrades a row.

Status vocabulary is exactly the charter's: `proven`, `mechanism-only`, and
`absent`.

## The 22 §11 drills

| §11 drill | Initial status on 2026-08-05 | Current status | Mechanism and evidence | Owner |
|---|---|---|---|---|
| Dispatcher crash before submit | `absent` | `absent` | Lease column exists but expiry semantics do not. INT-4c. | Dispatcher operator |
| Dispatcher crash after submit before binding write | `proven` | `proven` | **Restart suite case (exactly-once held).** | Dispatcher operator |
| Duplicate webhook/event | `mechanism-only` | `mechanism-only` | Projection dedupe exists; no disposable drill is cited yet. | INT-4d operator |
| Harness/DBOS unavailable | `absent` | `proven` | Amended 2026-08-05: Harness Postgres stop produced a file alert and direct Slack delivery while the watchdog stayed live. [INT-4a drill evidence](evidence/INT4A_WATCHDOG_DRILLS_2026-08-05.md). | Watchdog operator |
| Harness worker killed mid-run | `mechanism-only` | `mechanism-only` | Amended 2026-08-06: DBOS durability remains, and the kernel container audit now proves label-bound stopped-container detection plus `finally` cleanup to zero. A worker-kill/run-resumption drill is still not cited, so this row does not move to `proven`. [INT-4b evidence](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md). | INT-4b operator |
| Board unavailable | `mechanism-only` | `mechanism-only` | Harness execution is separated from the board; replay under board outage has not been drilled. | INT-4d operator |
| Policy changes after approval | `mechanism-only` | `mechanism-only` | Pre-submit policy/hash checks exist; no policy-change drill is cited. | Dispatcher operator |
| Approval/task hash mismatch | `proven` | `proven` | **Suite case.** | Dispatcher operator |
| Capability expansion | `proven` | `proven` | **Narrow/over-broad + memory.propose cases.** | Dispatcher operator |
| Budget/deadline exhaustion | `proven` | `proven` | **Budget-overrun case; live-cancel additionally proven by CI run 30980968234.** | Dispatcher operator |
| Global HALT during run | `proven` | `proven` | **HALT suite case.** | Operator |
| Verifier outage | `mechanism-only` | `mechanism-only` | Ineligible-handoff handling exists; no verifier-outage drill is cited. | Verification operator |
| Verification timeout | `proven` | `proven` | **Kernel #35 bounded `command_timeout_seconds` + suite.** | Verification operator |
| Verifier rejects output | `proven` | `proven` | **Negative fixture case.** | Verification operator |
| Malicious/oversized event | `absent` | `mechanism-only` | Amended 2026-08-06: a content-stable poison-read quarantine is proven red/green for malformed stored run state, including restart durability. The distinct malicious/oversized-input case has not been injected, so the exact §11 drill is not yet `proven`. [D0 silence](evidence/INT4B_D0_SILENCE_2026-08-06.md); [INT-4b evidence](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md). | INT-4b operator |
| Conflicting run binding | `mechanism-only` | `proven` | Amended 2026-08-06: a tampered run id produced both the dispatcher's durable quarantine marker and the independent watchdog's critical alert naming actual and intended ids. The pre-change loop read it for three live cycles without noticing it. [D0 silence](evidence/INT4B_D0_SILENCE_2026-08-06.md); [INT-4b evidence](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md). | INT-4b operator |
| PR head changes after handoff | `proven` | `proven` | **Identity-mismatch + head_conflict (#740).** | Actuation operator |
| PR API failure | `proven` | `proven` | **Crash-after-create convergence case.** | Actuation operator |
| Averray control-plane outage | `absent` | `absent` | No disposable outage drill is cited. | Economic operator |
| Settlement replay | `mechanism-only` | `mechanism-only` | Idempotency mechanisms exist; no settlement-replay drill is cited. | Economic operator |
| Direct fallback after Harness failure | `absent` | `absent` | No explicit fallback-decision drill is cited. | Operator |
| Hermes unavailable | `absent` | `proven` | Amended 2026-08-05: with every local Hermes/slack-operator container stopped, both dispatcher-stale and Harness-DB-down alerts reached direct Slack. [INT-4a drill evidence](evidence/INT4A_WATCHDOG_DRILLS_2026-08-05.md). | Watchdog operator |

The nine rows that began `proven` above retain the charter's citations
faithfully. INT-4a adds two proven rows; it does not reinterpret any other
mechanism as a completed drill.

## Charter §2 mechanism inventory

This preserves the charter's separate, grep-verified inventory. The baseline
wording remains visible; INT-4a amendments are dated rather than replacing it.

| Mechanism | 2026-08-05 charter baseline | Current status and dated evidence |
|---|---|---|
| Durable lease expiry | **Column exists, written `null` — `dispatch-claim.ts:155`. Schema-present, semantics-absent.** | `absent`; unchanged, owned by INT-4c. |
| Alert channel | **JSONL file sink only (`alerts.ts:8`); no consumer, no off-device path.** | `proven` on 2026-08-05: file-first consumer plus direct Slack delivery in [INT-4a evidence](evidence/INT4A_WATCHDOG_DRILLS_2026-08-05.md). The prior silence is [D0 evidence](evidence/INT4A_D0_SILENCE_2026-08-05.md). |
| External watchdog / source-age | **Nothing dispatcher-side; all hits are Hermes-stack files — the thing alerts must NOT depend on.** | `proven` on 2026-08-05 for dispatcher staleness, live-run source age, both Postgres reachability boundaries, and Hermes-independent Slack delivery. [INT-4a evidence](evidence/INT4A_WATCHDOG_DRILLS_2026-08-05.md). |
| Poison-event quarantine | **Kernel run-state `quarantined` is handled (`reconcile-run.ts:576`), but no dispatcher-side event quarantine.** | `proven` on 2026-08-06 for stable dispatcher read/projection failures: threshold accumulation, one critical alert, durable restart guard, and non-quarantining transient failures all ran through disposable Postgres. The exact malicious/oversized §11 input remains `mechanism-only` above. [INT-4b evidence](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md). |
| Duplicate-binding quarantine | **Refusal exists at claim time; no detector for divergence after the fact.** | `mechanism-only` on 2026-08-06: the dispatcher and watchdog now independently derive intended ids and detect shared run ids; the mismatch write/alert path is proven, while a disposable duplicate-row injection is not yet cited. [INT-4b evidence](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md). |
| Queue backpressure | **Absent.** | `absent`; unchanged, owned by INT-4c. |
| Orphan detectors | **Absent both sides; kernel half is filed as agent-harness#33.** | `proven` on 2026-08-06 for both age-gated reference/Harness orphan classes, per-id dedupe, the fresh-item exclusion, and label-bound stopped-container audit with cleanup to zero. [INT-4b evidence](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md). |

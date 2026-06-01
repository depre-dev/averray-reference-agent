# Testbed Mission Failure Triage — 2026-06-01

Scope: classify the failed `testbed-mission-*` runs that have been feeding B2 self-healing, then explain why some dispatched self-healing fixes failed. The cleanup is input/routing only: no product-state mutation and no authority change.

## Findings

| Mission | Created from id | Classification | Evidence |
| --- | ---: | --- | --- |
| `testbed-mission-mpmo4ff2-1` | 2026-05-26T13:25:41.774Z | STALE | Operator-captured runner output showed `fetch failed` caused by DNS `ENOTFOUND testbed.averray.com`. A later mission against `https://averray.com` completed with `verdict: pass`, so this is a pre-wiring/environment target failure rather than a current product regression. |
| `testbed-mission-mpn1ibrl-4` | 2026-05-26T19:40:25.233Z | STALE | Monitor screenshot showed a partial/failed report whose blocker was that HTTP visibility loaded the page but no real browser interaction ran yet. That predates the later browser-mission runner hardening and should not keep spawning product-fix proposals after newer missions exist. |
| `testbed-mission-mptk0f2y-5` | 2026-05-31T09:04:59.482Z | REAL until superseded | This was created after the real testbed runner wiring landed. Without a newer passing/running mission for the same target, B2 should still treat it as a live signal and propose/escalate through the existing guardrails. |
| `testbed-mission-mptmzrcn-6` | 2026-05-31T10:28:27.575Z | REAL until superseded | Fresh enough to be post-wiring. Keep eligible unless a newer same-target mission supersedes it or it ages beyond the stale-input window. |
| `testbed-mission-mptpfgmh-8` | 2026-05-31T11:36:39.401Z | REAL until superseded | Fresh enough to be post-wiring. Keep eligible unless a newer same-target mission supersedes it or it ages beyond the stale-input window. |

## Layer 2 — why self-healing fix tasks failed

B2 was turning every recent latest-per-target failed testbed mission into a code-agent proposal when a repo was configured. That was too broad.

Evidence in code:

- `services/slack-operator/src/monitor-testbed-missions.ts` has two different failure layers: `mission_report_needs_fix` means a browser-agent product report exists; `mission_runner_failed` means the runner/report pipeline failed before a trustworthy product report existed.
- `services/slack-operator/src/index.ts` collected both kinds into the same `FailureSignal` with `repo`, so the self-healing core treated runner/report failures as routable code work.
- The generic B2 prompt only included a board URL as evidence. The hosted board is Cloudflare-protected from a fresh agent context, so a Claude worker could receive a vague "testbed mission failed" task with no durable product evidence it can act on.
- `testbedMissionCodexFollowupPrompt()` already contains the richer product-fix prompt, but B2 was not using it for self-healing proposals.

Conclusion: some self-healing tasks were doomed because the target was not a real code task yet. Runner/report-pipeline failures need human/operator diagnosis; structured browser-agent product failures can still become a code-agent fix.

## Code decision

B2 should not delete or rewrite mission history. Instead, its input now filters and classifies failed testbed missions before self-healing can dispatch work:

- Keep only the newest mission per target surface.
- Drop a failed mission once a newer mission for that target exists, including a pass, requested, ready, or running rerun.
- Drop failed missions older than `B2_SELF_HEALING_TESTBED_FAILURE_MAX_AGE_HOURS` (default: 72).
- For the remaining failed missions, propose a self-healing code task only when the run has a structured browser-agent product report.
- Use the structured testbed follow-up prompt for product-fixable missions so the worker gets blocker, UX gap, proof, and evidence without relying on a protected board link.
- Escalate runner/report-pipeline failures as `not_auto_fixable` instead of dispatching a doomed code-agent task.

This is a read-only input guard. It does not create, approve, dismiss, or mutate product work.

# Testbed Mission Failure Triage — 2026-06-01

Scope: classify the failed `testbed-mission-*` runs that have been feeding B2 self-healing, then add a safe stale-input guard without changing product state or task authority.

## Findings

| Mission | Created from id | Classification | Evidence |
| --- | ---: | --- | --- |
| `testbed-mission-mpmo4ff2-1` | 2026-05-26T13:25:41.774Z | STALE | Operator-captured runner output showed `fetch failed` caused by DNS `ENOTFOUND testbed.averray.com`. A later mission against `https://averray.com` completed with `verdict: pass`, so this is a pre-wiring/environment target failure rather than a current product regression. |
| `testbed-mission-mpn1ibrl-4` | 2026-05-26T19:40:25.233Z | STALE | Monitor screenshot showed a partial/failed report whose blocker was that HTTP visibility loaded the page but no real browser interaction ran yet. That predates the later browser-mission runner hardening and should not keep spawning product-fix proposals after newer missions exist. |
| `testbed-mission-mptk0f2y-5` | 2026-05-31T09:04:59.482Z | REAL until superseded | This was created after the real testbed runner wiring landed. Without a newer passing/running mission for the same target, B2 should still treat it as a live signal and propose/escalate through the existing guardrails. |
| `testbed-mission-mptmzrcn-6` | 2026-05-31T10:28:27.575Z | REAL until superseded | Fresh enough to be post-wiring. Keep eligible unless a newer same-target mission supersedes it or it ages beyond the stale-input window. |
| `testbed-mission-mptpfgmh-8` | 2026-05-31T11:36:39.401Z | REAL until superseded | Fresh enough to be post-wiring. Keep eligible unless a newer same-target mission supersedes it or it ages beyond the stale-input window. |

## Code decision

B2 should not delete or rewrite mission history. Instead, its input now filters failed testbed missions before self-healing sees them:

- Keep only the newest mission per target surface.
- Drop a failed mission once a newer mission for that target exists, including a pass, requested, ready, or running rerun.
- Drop failed missions older than `B2_SELF_HEALING_TESTBED_FAILURE_MAX_AGE_HOURS` (default: 72).

This is a read-only input guard. It does not create, approve, dismiss, or mutate product work.

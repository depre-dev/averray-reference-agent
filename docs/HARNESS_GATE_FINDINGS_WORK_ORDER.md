# Work order — two defects found while gating, each in a check's honesty

> Both surfaced during INT-4 gating, both filed rather than smuggled into the
> packet that found them, both small. They share a theme worth naming: a check
> that runs but **says the wrong thing**, and a check that **doesn't run while
> looking like it did**.
>
> Two independent deliverables, **two separate PRs**. Neither blocks the other.

## 1. Deliverable D1 — #764: corruption is not authority expansion

`reconcile-run.ts:551-566`. Every non-terminal-unresolvable projection failure
force-cancels with:

```
code:    containment_expansion
message: "Harness projection exceeded the approved task authority;
          the run was cancelled and blocked."
```

Two distinct causes land there. `assertAgentRunProjectionWithinTask` throwing
**is** an authority breach and the message is right. A parse or schema failure
in `projectHarnessRun` is **corrupt data** — nothing exceeded anything, and an
operator triaging that alert hunts a breach that never happened.

Split by cause, not by guesswork:

- containment assertion failed → `containment_expansion`, message unchanged
- projection parse/validation failed → new code `projection_invalid`, message
  saying the projection could not be read, not that authority was exceeded

**Severity, cancellation, and lifecycle stay identical.** Corrupt data still
cancels and still blocks — only the words change to match the cause. This is a
labelling fix; if you find yourself changing what happens, stop.

`containment_expansion` is a **shared alert vocabulary**. Adding a code is a
contract change: check every consumer (`dispatch-attempt.ts` severity mapping,
pilot status, watchdog forwarding, the drill ledger's cited cases) and state in
the handback that the new code is handled everywhere the old one is.

**Prove both branches by mutation**, each seen red:
- make the containment assertion throw → must emit `containment_expansion`
- feed a malformed projection → must emit `projection_invalid`
- swap the two codes → both tests must fail (proves they are distinguished, not
  merely both present)

## 2. Deliverable D2 — #773: a mutation harness that no-ops silently

`INT4C_MUTATION` with an unrecognized value is ignored by every fixture, so
`run-int4c-drills.mjs --mutation typo` reports a green 6/6 while testing
nothing. I proved it by doing it during the 4c gate.

That is the exact defect class this integration exists to remove, sitting in
the tool we use to remove it: a mutation run that looks armed and is not. A
CI job or a future gate with a typo'd name would report green forever.

Fix both halves:

- the fixtures (or the runner) hold the known-name list and **exit non-zero on
  an unrecognized value**, naming the value and listing the valid ones;
- the drill test asserts `INT4C_MUTATION_APPLIED=<name>` appears in child
  output whenever a mutation was requested — so a name that is recognized but
  never reaches its seam also fails.

**Apply the same treatment to 4b and 4d** if their harnesses share the shape —
check, and say in the handback which harnesses were audited and what each did.

**Prove it**: `--mutation not-a-real-name` must exit non-zero; a valid name
must still red its own drill exactly as before, unchanged.

## 3. What must not change

Alert severities, cancellation behaviour, lifecycle transitions · the suites
(INT-2 14, INT-3b 29, 4b 5, 4c 6, 4d 6) · the watchdog and its import test ·
quarantine, lease, claim, policy semantics · `deriveIntendedRunId` · the
burn-in battery, its ledger and evidence · the drill ledger's existing rows and
citations, except where D1's new code needs one updated.

## 4. Out of scope

The seeding retirement (its own order) · any other alert code · `rubric` ·
INT-5 · money rail.

## 5. Decisions

1. **Labels are load-bearing.** An operator routes by the alert code; a wrong
   code sends them hunting the wrong failure. Same action, honest words.
2. **A harness that cannot refuse a bad input is not a harness.** The tool that
   proves our checks fire must itself fail loudly when misused.
3. **Both fixes are proven by mutation**, including the swap test — a pair of
   codes that both exist but are never distinguished would pass a naive test.

### Operator note

Nothing to provision or decide. After D1 an alert saying "authority exceeded"
means authority was actually exceeded; after D2 a mutation run that reports
green was actually armed.

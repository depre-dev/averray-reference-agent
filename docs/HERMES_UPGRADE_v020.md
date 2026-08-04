# Hermes v0.18.0 → v0.20.0 — and why the v0.19.1 NO-GO was wrong

Written 2026-08-04. Companion to `HERMES_UPGRADE_v018.md` / `v019.md`; same
shape — upstream diffed against **what we actually use**, not a feature tour.

## 0. Bottom line

| | |
|---|---|
| Running | **v0.20.0** (`v2026.8.3`) since 2026-08-04 — was v0.18.0 (`v2026.7.1`) for a month |
| Released | v0.20.0 shipped 2026-08-03; taken the next day |
| Skipped | v0.19.1 — NO-GO on 2026-07-31, **on a diagnosis that was wrong** (§1) |
| Verdict | **DONE — upgraded and verified 2026-08-04.** See §6 |


It is **v0.20.0**, not "2.0" — the project is still on a 0.x line.

## 1. The v0.19.1 diagnosis was wrong

`HERMES_UPGRADE_v019.md` §3.5.4 concluded that the Session API never bound
because of one of two upstream bugs: [#74505](https://github.com/NousResearch/hermes-agent/issues/74505)
(top-level `api_server:` YAML keys not bridged into `extra`) or
[#75348](https://github.com/NousResearch/hermes-agent/issues/75348)
(`PORT_BINDING_PLATFORM_VALUES` not containing the platform). It named a
deciding check: *is `api_server` in that allowlist?*

Both were resolved by running the real config loader inside both images, with
this repo's own committed `hermes/config/hermes.yaml` mounted and our real
env-var shape (dummy 44-character key, same strength class as production):

```
                        v0.19.1 (v2026.7.30)   v0.20.0 (v2026.8.3)
api_server registered            True                 True
enabled                          True                 True
extra keys              ['host','key','port']  ['host','key','port']
in bind allowlist                True                 True
```

**Identical, and correct, on both.** So:

- `api_server` was always in the allowlist — #75348 is about Baileys WhatsApp
  being *absent* from it and never applied to us.
- The `extra` bridge always populated for us — our key arrives via **env**
  (`API_SERVER_KEY`, from `HERMES_GATEWAY_API_KEY`), not top-level YAML, and the
  env path writes `extra` directly. #74505 was never our code path. It is also
  fixed in the shipped image regardless: `gateway/config.py` bridges all five
  keys (`port`, `key`, `host`, `cors_origins`, `model_name`) even though the PR
  is still open on GitHub — *a PR's open state does not tell you what is in a
  release.*

A third theory — that `has_usable_secret(key, min_length=16)` was silently
skipping the whole env branch — also died on contact: the production key is 44
characters and passes.

**So the failure is downstream of config resolution**, in the adapter's
`connect()` or the bind itself.

### 1.1 SETTLED 2026-08-04 — a weak key IN THE SMOKE, not a v0.19.1 defect

The v0.19.1 smoke container was still on the box, exited, three days later. Its
log names the cause outright:

```
ERROR gateway.platforms.api_server: [Api_Server] Refusing to start:
  API_SERVER_KEY is a placeholder or too short (<16 chars).
ERROR gateway.run: Gateway hit a non-retryable startup conflict
ERROR gateway.run: Gateway exiting cleanly
```

Platform registers, nothing binds, no bind attempt logged — the exact symptom,
fully explained. `has_usable_secret(key, min_length=16)` gates the whole
`API_SERVER_*` env branch, and the smoke's key failed it.

**v0.19.1 was almost certainly never broken.** The NO-GO was an artifact of the
test harness. Production's `HERMES_GATEWAY_API_KEY` is 44 characters and passes
the same guard — which is why v0.20.0 bound on the first attempt.

The near-miss worth recording: this mechanism was found hours earlier and then
discarded, because **production's** key was measured instead of the **smoke's**.
A correct reading of the wrong subject — the same failure class as the Bank
lane's stale-subject incident that same day, and the reason a month went into
waiting for an upstream fix that was never needed.

The correction matters more than the conclusion: a wrong root cause left
standing in a doc misdirects the next attempt, and this one already did.

## 2. What is actually ours to break

Nothing about Hermes is forked. The entire surface we ship into it:

| | |
|---|---|
| `hermes/config/` | 2 files — `hermes.yaml`, `policy.yaml` |
| `hermes/plugins/` | 1 file — `averray_trace_plugin.py` |
| `hermes/skills/` | 1 skill — `ops/averray-ops` |
| image | stock upstream, pinned by `HERMES_IMAGE` |

The coupling is **integration**, not customisation, and it is thin:

1. **The Session API** — `HermesSessionClient` calls `/api/sessions`, `/chat`,
   `/chat/stream`, `/fork`. The only point that has ever blocked an upgrade.
2. **The MCP bundle** — five servers published into `avg-app`; tool lists
   register once at consumer startup. v0.20.0 changes exactly this with lazy
   startup from a fingerprint-keyed on-disk schema cache.
3. Skills volume, trace plugin, gateway port — trivially replaceable.

**The board does not depend on Hermes.** The money path runs through a failed
upgrade untouched, and #657 already made that deploy gate advisory.

## 3. Why "wait until it settles" was the wrong policy

Every release is two days old at some point and every one has open bugs, so a
rule that says "not yet" has no exit condition — it resolves to never
upgrading, while the jump grows and each attempt gets harder to debug. We spent
a month on v0.18 and a day on a wrong diagnosis.

Release age is a *proxy* for risk. A restorable snapshot plus two narrow checks
is a *measurement* of it. `ops/upgrade-hermes.sh` replaces the proxy.

**The one real unknown is on-disk state.** `/opt/data` holds `memory.db`,
sessions and plugins; both versions carry SQLite schema handling and v0.20.0
adds `session_recovery.py`. If the new version migrates that volume, an older
image may not read it back — which is the only thing that could turn "revert the
tag" into a loss. The snapshot converts that unknown into a controlled fact
instead of a reason to postpone.

## 4. The procedure

```bash
ops/upgrade-hermes.sh v2026.8.3     # snapshot, pin, recreate, check
ops/upgrade-hermes.sh --check-only  # run the checks against what is live now
```

1. **Snapshot `avg_avg-hermes`** to a tarball named for the version it came
   *from*. Fatal if it fails — nothing else runs.
2. **Pin the tag in `.env.prod`** (with a timestamped backup), not as a one-shot
   override that would silently revert on the next deploy.
3. **Recreate only `hermes` + `hermes-gateway`**, with `--no-deps` — pulling
   deps would re-run `hermes-permissions` and its `chmod -R 0777 /opt/data`,
   re-opening the volume Hermes secures to 0700.
4. **Two checks**, deliberately narrow because a check that tests everything is
   a check nobody runs:
   - **Session API binds and answers** — `POST /api/sessions` returns 201.
     `/health` is *not* sufficient: on v0.19.1 the gateway reported healthy
     while nothing listened. The check distinguishes *nothing listening* from
     *bound but not serving*; both failure modes were exercised locally.
   - **MCP tool surface** — `hermes mcp test averray` must connect AND list
     `averray_board_health`. Not a log grep: under lazy startup the boot log is
     silent on MCP whether the surface is healthy or dead (§6). Not `mcp list`
     either: that reports what is configured, and configured is not working.

It does **not** roll back on its own. A failed check prints the exact revert
commands and stops — humans own deploy, and auto-restoring a data volume is not
a decision a script should take.

## 5. Still unverified

- ~~Whether v0.20.0 binds.~~ **Verified 2026-08-04: 201, see §6.**
- **The MCP schema cache's effect on bundle-consumer restarts.** The surface is
  verified healthy (§6), but `deploy-monitor.sh` still restarts bundle consumers
  by hand because tool lists registered once at startup. Under LAZY startup that
  compensation may now be redundant — or still necessary if the fingerprint
  cache does not notice a republished bundle. Untested either way.
- **The SessionState consolidation** (19 session-keyed dicts → one scoped
  object) sits under `HermesSessionClient`. No breaking changes are documented,
  which is not the same as none.
- **Buzz** lands as a bundled gateway platform in v0.20.0. Out of scope here;
  this doc covers getting onto the version, not the cutover.

## 6. The live run, 2026-08-04

Upgraded v0.18.0 → v0.20.0 in about 90 seconds. Snapshot 360M, unused.

| | |
|---|---|
| Session API | `POST /api/sessions` → **201** (baseline on v0.18 also 201) |
| MCP `averray` | connected in **553ms**, **37 tools**, `averray_board_health` present |
| gateway | healthy; `avg-hermes-1` up |
| snapshot | `hermes-data-v2026.7.1-20260804T091837Z.tgz` — keep ~1 day |

### What the run taught that reading could not

**CHECK 2 was designed wrong, not merely windowed wrong.** It grepped the boot
log for MCP lines. On v0.20.0 the gateway logs *nothing* about MCP at boot,
because lazy startup means nothing has connected — so **silence is the healthy
output**, and identical to what a completely broken server would produce. The
check reported "no MCP lines" against a perfectly good tool surface.

It now runs `hermes mcp test averray`, which **connects** and enumerates: the
act of asking is what proves the path. `hermes mcp list` is not a substitute —
it listed all five servers as "enabled" while none had connected. Configured is
not working.

### Two things v0.20.0 surfaced

**A security warning that was previously silent** (new warning, almost certainly
not a new condition):

> API server is network-accessible (0.0.0.0) AND the terminal backend is
> 'local' (unsandboxed). Agent work dispatched through this endpoint runs as
> the host user with full terminal/file access.

Compose publishes `127.0.0.1:8642:8642`, so the `0.0.0.0` is the bind *inside*
the container and it is not internet-reachable. But every container on
`avg_avg-internal` can reach `hermes-gateway:8642` directly, so the accurate
statement is: anything on that network holding the key has host-level code
execution as the container user. `terminal.backend: docker` is the upstream
mitigation. **A real decision, not upgrade cleanup — tracked separately.**

**The skills tree did not move with the image.** ~26 bundled skills report
"you already have a local skill by this name — yours was kept", so the agent
runs v0.18-era bundled skills under a v0.20.0 binary. `ops/averray-ops` is
unaffected (bind-mounted from the repo, synced by `deploy-monitor.sh`).

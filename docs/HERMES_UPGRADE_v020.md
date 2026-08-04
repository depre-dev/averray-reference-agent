# Hermes v0.18.0 → v0.20.0 — and why the v0.19.1 NO-GO was wrong

Written 2026-08-04. Companion to `HERMES_UPGRADE_v018.md` / `v019.md`; same
shape — upstream diffed against **what we actually use**, not a feature tour.

## 0. Bottom line

| | |
|---|---|
| Running | **v0.20.0** (`v2026.8.3`) since 2026-08-04 — was v0.18.0 (`v2026.7.1`) for a month |
| Released | v0.20.0 shipped 2026-08-03; taken the next day |
| Skipped | v0.19.1 — NO-GO on 2026-07-31, **on a diagnosis that was wrong** (§1) |
| Verdict | **Upgraded 2026-08-04. Declared verified, WAS NOT** — it broke every answer for six hours (§7) |


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
4. **Three checks**, deliberately narrow because a check that tests everything is
   a check nobody runs:
   - **Session API binds and answers** — `POST /api/sessions` returns 201.
     `/health` is *not* sufficient: on v0.19.1 the gateway reported healthy
     while nothing listened. The check distinguishes *nothing listening* from
     *bound but not serving*; both failure modes were exercised locally.
   - **MCP tool surface** — `hermes mcp test averray` must connect AND list
     `averray_board_health`. Not a log grep: under lazy startup the boot log is
     silent on MCP whether the surface is healthy or dead (§6). Not `mcp list`
     either: that reports what is configured, and configured is not working.
   - **A turn actually completes** — post to `/v1/chat/completions` using the
     model id read from `GET /v1/models`, and assert non-empty content. Added
     after v0.20.0 shipped six hours of 404s past the first two (§7). The first
     check proves the API *accepts* work; only this one proves it *does* any.

It does **not** roll back on its own. A failed check prints the exact revert
commands and stops — humans own deploy, and auto-restoring a data volume is not
a decision a script should take.

## 5. Still unverified

- ~~Whether v0.20.0 binds.~~ **Verified 2026-08-04: 201, see §6.**
- ~~The MCP schema cache's effect on bundle-consumer restarts.~~ **TESTED
  2026-08-04 — the compensation is NOT redundant, it became INSUFFICIENT.**
  `tools/mcp_schema_cache.py` keys on `config_fingerprint(command, args, url,
  transport, tool filters)` and does **not** hash server code, so republishing
  the bundle leaves the fingerprint identical and the cache serves the old
  manifest. It refreshes on a live connect, so a CHANGED tool self-heals on
  first use — but a NEWLY ADDED tool cannot: the model never learns it exists,
  so it never calls it, so the refreshing connect never happens. The cache lives
  at `/opt/data/cache/mcp_schema_cache.json` on the persisted `avg-hermes`
  volume (confirmed on the live box), so it survives restarts *and* recreates.
  `deploy-monitor.sh` now deletes it whenever the bundle id changes.
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

## 7. The regression this upgrade shipped, and the check that missed it

**Symptom.** From 12:48 on 2026-08-04, every question asked in the Buzz `#Ops`
channel came back:

```
API call failed after 3 retries: HTTP 404: model "hermes-agent" not found
```

Roughly six hours, on the control plane, while §6 recorded the upgrade as
verified.

**Root cause.** The `api_server` platform is OpenAI-compatible, so it advertises
a model in `GET /v1/models` and clients send that id back on every request. With
`model_name` unset it advertises the string `hermes-agent` — a **virtual** name
Hermes is meant to recognise as its own and swap for the configured model before
calling the provider. `gateway/platforms/api_server.py` still carries the intent:
`_request_agent_overrides(body, virtual_model=self._model_name)`, and it only
treats a request as a route when `model != self._model_name`.

On v0.20.0 the swap stopped happening. The virtual name reached Ollama Cloud
verbatim, and Ollama answered correctly — it has no such model.

Everything else was healthy, which is why this took so long to find:

| Suspected | Actual |
|---|---|
| Config wrong | `hermes config get model` → `glm-5.2:cloud`. Correct. |
| `:cloud` suffix retired | All four names tested → **200**. Suffix is fine. |
| `hermes-agent` a catalog fallback | 0 occurrences in `models_dev_cache.json`. |
| api_server dead | `gateway_state.json` said `fatal` — **a stale corpse**; live `POST /api/sessions` → 201. |
| The bundled `hermes-agent` skill | Name collision only. Unrelated. |

The only wrong value in the entire system was the name on the wire.

**Fix.** `hermes/config/hermes.yaml` now sets
`platforms.api_server.model_name: glm-5.2:cloud`. This does not depend on
upstream restoring the swap: whether or not the virtual name is resolved, the
string clients send is now one the provider honours. The pass-through stops
being a failure mode rather than merely being avoided.

`test/unit/hermes-config.test.ts` reads the file and fails if `model_name` is
absent, is `hermes-agent`, or drifts from `model.default`. Verified by breaking
the config both ways and watching it go red — the config is a mounted artefact,
so a test that reads it is the only thing that can guard it.

### The check was wrong, and it was wrong in a way we had already been warned about

CHECK 1 does `POST /api/sessions` → 201 and calls that proof. **Creating a
session is not completing one.** It proved the API binds, which is genuinely the
v0.19.1 failure it was written for, and then that pass got read as "the upgrade
works". The answer path was never exercised. §6's own lesson about CHECK 2 —
that a check has to *do the thing* rather than observe a proxy for it — applied
here too and was not carried across.

CHECK 3 now completes a real turn and asserts on content. Two properties matter:

- **It sends the model id read from `GET /v1/models`, not a hardcoded name.**
  That is the exact string a client sends. Hardcoding `glm-5.2:cloud` would have
  passed green straight through this outage, because the *configured* model was
  never the broken one.
- **It asserts non-empty content**, because a 200 with empty `choices` is the
  same class of false pass as a 201 that never completed.

Both of its JSON extractions normalise `\"` first. Without that the failure line
for this very incident renders as `model \` — a check that names nothing. Found
by running the real payload through it, not by reading it.

### Still open after this fix

- **The auxiliary lane leaks to a paid fallback.** The gateway logs
  `PAID lane engaged — OpenRouter fallback model 'google/gemini-3.6-flash' is
  not a :free SKU and may incur real spend`, despite `auxiliary.background_review`
  being pinned to ollama-cloud. Real money; needs its own pass.
- **`terminal.backend: local` on a `0.0.0.0` listener.** The warning is real and
  the docker backend is not the answer (no socket is mounted; granting one is
  worse). Firewalling 8642 is. Unowned.
- **Whether upstream intends the virtual-name swap to still work.** Worth an
  issue; our fix is deliberately independent of the answer.

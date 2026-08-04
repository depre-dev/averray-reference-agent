# Hermes v0.18.0 → v0.20.0 — and why the v0.19.1 NO-GO was wrong

Written 2026-08-04. Companion to `HERMES_UPGRADE_v018.md` / `v019.md`; same
shape — upstream diffed against **what we actually use**, not a feature tour.

## 0. Bottom line

| | |
|---|---|
| Running | **v0.18.0** (`nousresearch/hermes-agent:v2026.7.1`), since 2026-07-02 |
| Latest | **v0.20.0** (`v2026.8.3`), released 2026-08-03 |
| Skipped | v0.19.1 — NO-GO on 2026-07-31, **on a diagnosis that was wrong** (§1) |
| Verdict | **Attempt it.** Not because the release is proven, but because the
abort is cheap and the wait was not buying anything (§3) |

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
`connect()` or the bind itself. `gateway/platforms/api_server.py` did change
between the two versions (6,955 → 7,146 lines, different hash), which makes a
fix *possible* and **not established**. Only a boot answers it — hence §4.

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
   - **MCP tool surface** — reported, not asserted. The fingerprint-keyed cache
     could fix the stale-tool-list problem of 2026-08-02 or add a second stale
     layer; the script prints what the gateway says so it can be compared.

It does **not** roll back on its own. A failed check prints the exact revert
commands and stops — humans own deploy, and auto-restoring a data volume is not
a decision a script should take.

## 5. Still unverified

- **Whether v0.20.0 binds.** Config resolution is clean; the bind is not proven.
- **The MCP schema cache's effect on bundle-consumer restarts** —
  `deploy-monitor.sh` currently compensates by hand for tool lists registering
  once at startup. If the cache changes that, that compensation may become
  wrong rather than merely redundant.
- **The SessionState consolidation** (19 session-keyed dicts → one scoped
  object) sits under `HermesSessionClient`. No breaking changes are documented,
  which is not the same as none.
- **Buzz** lands as a bundled gateway platform in v0.20.0. Out of scope here;
  this doc covers getting onto the version, not the cutover.

# Hermes v0.14 → v0.17 — Capability & Upgrade Eval

- **Status:** Evaluation / recommendation only. **No implementation.** Written to decide what of the v0.15–v0.17 wave is worth adopting for Averray.
- **Date:** 2026-07-01
- **Lens:** Hermes is the operator's right-hand orchestrator in Averray. The question this doc answers is **"what makes Hermes maximally capable and *agentic* for us"** — not a generic changelog.
- **Pinned image:** `nousresearch/hermes-agent@sha256:b6e41c1…` = **v0.14.0 / v2026.5.16** (`ops/.env.example:11`).
- **Upstream now:** **v0.17.0 / v2026.6.19** (`latest`/`main` rebuilt 2026-07-01). We are **3 majors / ~2,350 merged PRs** behind.
- **Sources:** [v0.15](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.5.28) · [v0.16](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.5) · [v0.17](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19).

---

## 0. Bottom line

**Keep your control plane. Upgrade the brain. Harden the box.**

You have *already built and shipped* a mature orchestration control plane (O1–O5 live: attribution → Claude worker → board dispatch → `enqueue_agent_task` + `dispatch-policy.ts` guardrail → supervised/autopilot autonomy → D3 anomaly auto-pause), tuned to invariants upstream doesn't know about (human merge/deploy gate, Codex-owns-chain, truth-boundary, 4h autopilot cap, fail-closed dispatch allowlist). **Do not rip that out for upstream's native Kanban** — you'd lose exactly the guardrails that make autonomy safe here.

The value of v0.15–v0.17 for us is in three places, none of which touch that control plane:

1. **The Hermes *brain*** — the intelligence your control plane calls (agent loop, subagents, skills, memory, MCP, models). This got dramatically more agentic. **This is the prize.**
2. **Ops/deploy** — s6 supervision, an orphan reaper, and smarter volume-ownership handling — i.e. upstream's own fix for the zombie + skills-volume-perms problems we just hand-patched.
3. **Security** — promptware/injection defense + a stack of CVE fixes, directly relevant to the pre-audit posture.

Recommended: a **staged image bump to v0.17 on a throwaway profile first** (because of the s6 Docker change and its coupling to the `skills-observer` fix we just shipped in #464), then turn on the brain-level capabilities via config, then optionally borrow a couple of upstream patterns into our control plane. **Do not blind-bump the prod pin.**

---

## 1. The reframe — brain vs. control plane

Your `HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md` §3 lists Hermes capabilities as **"[assumed] from README — confirm against the running image."** v0.15–v0.17 *is* that confirmation, and every one of those assumptions got stronger. But the plan's build targets (P2–P5) are **already shipped** as your own code — so the map is:

| Layer | Who owns it | Verdict |
|---|---|---|
| Board / lanes / co-pilot rail / truth-boundary signaling | **You** (`monitor-ui`, `slack-operator`) | **Keep.** Upstream's Kanban dashboard is a different UX and doesn't know your invariants. |
| Task queue + per-agent runners (codex/claude/test-writer/security/docs) | **You** (`codex-task-queue.ts`, `*-branch-worker.ts`) | **Keep.** Command-agnostic, secret-sanitized, tuned. |
| Dispatch guardrail + autonomy mode + anomaly auto-pause | **You** (`dispatch-policy.ts`, `policy.yaml`) | **Keep.** This is your security boundary; upstream has nothing equivalent to your 4h cap + high-risk escalation + HALT_FILE tiering. |
| **Agent loop, subagents, skills, memory, MCP client, models** | **Hermes (the brain)** | **⬆ Upgrade.** This is what v0.15–v0.17 supercharged. |
| Container supervision, volume ownership, reaping | **Hermes image + our compose** | **⬆ Upgrade** (rides along with the bump; see the #464 coupling). |

So: **your plane calls the brain over MCP + a chat/session entry point.** Make the brain smarter and more autonomous, and the whole system Hermes-orchestrates better — with your guardrails still in force.

---

## 2. What to ADOPT — capability & agency (the prize)

Ranked by leverage for "capable, agentic right-hand." Effort is *our* integration effort, not upstream's.

### 2.1 Background / async subagents — **ADOPT (highest leverage)**
`delegate_task(background=true)` dispatches a subagent that runs in the background and returns a handle immediately; its result re-enters the conversation as a new turn when done (v0.17). v0.16 also **uncapped delegation `max_spawn_depth`** and removed the default subagent wall-clock timeout.
- **Why it matters for us:** today Hermes is invoked one-shot over SSH (`hermes chat -q`). A right-hand orchestrator should fan out — kick off a research dive, a multi-file analysis, a triage pass — and keep working. This is the single biggest "feels agentic" upgrade, and it's the concrete version of the plan's §3 "subagent spawning" assumption.
- **Maps to:** Rung-C planner (P4) — Hermes decomposing and delegating while it narrates.

### 2.2 Persistent orchestration via the Session API — **ADOPT**
v0.15 shipped a real **Session control API** (`/api/sessions/*`: list/create/read/patch/delete/**fork**) with **SSE-streaming chat**, plus `GET /v1/skills` and `/v1/toolsets`. v0.16 added **remote-gateway connections authenticated with OAuth / username-password** over WebSocket.
- **Why it matters for us:** your own `HERMES_INTEGRATION_MAP.md` Q6 says *"prefer the gateway API over SSH `hermes chat` for the Rung-C loop."* This is that API, now mature. Moving the orchestration loop from fire-and-forget SSH prompts to a **persistent, forkable, streamed session** is what turns Hermes from a batch reviewer into a live collaborator — and it's a better fit for the co-pilot rail than shelling a one-shot.
- **Effort:** medium — enable the gateway API (you already have the `command-center` overlay with `:8642`), then point the orchestration/co-pilot path at `/api/sessions` instead of `ssh … hermes chat`.

### 2.3 Skills + curator maturation — **ADOPT (cheap, high-fit)**
- **Curator is now zero-token on routine runs** (v0.17): deterministic prune stays on; the aux-model consolidation pass is **opt-in** (`curator.consolidate: true`). Routine background curation costs **0 tokens**.
- **Skill bundles** (`/<name>` loads a whole workflow), an **`environments:` relevance gate** (keep context-specific skills out of the index), and the curator can now prune **built-in** skills with per-skill usage tracking.
- **Why it matters for us:** the plan's P4/P5 "learnable routing playbook" + "per-agent success memory" *is* the skills+memory loop. Cheaper, sharper curation directly serves the budget discipline, and your `skills-observer` already ingests these — fewer noisy writes is a win. **Flip `curator.consolidate: false` regardless of upgrade timing** (it's the default now upstream).

### 2.4 `memory` tool — atomic batch operations — **ADOPT (free with bump)**
v0.17: the `memory` tool gained an `operations` array applying add/replace/remove **atomically against the final character budget** — one call can free space and add entries even when an add alone would overflow.
- **Why it matters:** P5's "learned routing / per-agent performance memory" needs reliable memory writes. This kills the fragile multi-turn memory dance. Free once you're on v0.17.

### 2.5 MCP hardening — **ADOPT (our entire integration bus)**
Everything Hermes does in Averray rides `averray_*` MCP tools, so MCP quality is our quality:
- **Elicitation handler** (v0.17): MCP servers can prompt for **mid-tool-call confirmation** (payment/OAuth) on whichever surface owns the session. **This maps directly onto our approval gates** — e.g. a dispatch/mutation could elicit operator confirmation inline instead of parking.
- **Progressive tool disclosure** (scoped) — smaller prompt, less tool-confusion → a sharper agent.
- **mTLS for HTTP/SSE MCP servers**, **exfil-shaped stdio config blocking**, late-connecting tools exposed between turns (cache-safe), `optional board param on all MCP tools`.
- **Effort:** mostly free with the bump; elicitation is an opt-in integration worth a spike.

### 2.6 Models — **ADOPT (config-only)**
You run `deepseek-v4-pro:cloud` via ollama-cloud (`hermes.yaml`; `hermes-pr-handoff.yml`). The v0.16–v0.17 catalog adds **`deepseek-v4-flash`**, **MiniMax-M3 (1M context)**, **glm-5.2 (1M)**, **`anthropic/claude-fable-5`**, **gpt-5.5** (Codex OAuth), and **grok-composer-2.5**, plus a fuzzy picker and hourly catalog refresh. Per-task model overrides exist too.
- **Why it matters:** a right-hand is only as capable as its model. A cheap-fast model (deepseek-v4-flash) for triage/narration + a strong model for hard routing calls is exactly the "per-task model" pattern. **Confirm `deepseek-v4-pro:cloud` still resolves** on v0.17 (model-retirement detection landed for xAI; deepseek-via-ollama should be unaffected — verify).

### 2.7 Automation Blueprints + pluggable cron — **BORROW/ADOPT (nice-to-have)**
v0.17: **Automation Blueprints** (parameterized automations that render as a dashboard form *and* a CLI/messenger slash command *and* a docs entry from one definition) + a **pluggable CronScheduler** with a scale-to-zero managed provider. Your daily operator reports already run on Hermes cron.
- **Why it matters:** cleaner, safer scheduled routines; a blueprint is a good shape for "operator self-report," "post-deploy verify," etc. Low urgency.

---

## 3. What RIDES ALONG — ops & security (comes with the image)

### 3.1 Docker/ownership — **directly fixes what we just hand-patched**
- **s6-overlay container supervision** (abstract ServiceManager; per-profile gateway supervision; `gateway run` auto-redirects to supervised mode).
- **Orphan reaper + container reuse/bounded-sync cleanup** (v0.16) — upstream's version of the **zombie reaping** we did with `init: true`.
- **"Skip boot chown when volume ownership matches the remapped UID"** (v0.16) and **"repair cron ownership on container restart"** (v0.17) — upstream's version of the **skills-volume ownership** problem we just fixed in #464.
- Container labels for identification; Node 22 LTS base; image-size trims.
- **⚠ Coupling with #464:** our `skills-observer` fix hardcodes `user: "10000:10000"` because the *current* image owns the skills volume as UID 10000 at 0700. The new image's **UID-remap / boot-chown** behavior may change that ownership. **A v0.17 bump must re-verify the skills-volume owner and that `user: "10000:10000"` still matches** (`docker run --rm -v avg_avg-hermes-skills:/s alpine stat -c '%u:%g %a' /s`). This is the #1 concrete integration check.

### 3.2 Security — **fits the pre-audit posture**
- **Promptware / "Brainworm"-class prompt-injection defense** (v0.15): threat-pattern chokepoints, tool-output delimiter markers, recalled-memory scanning, a bundled `security-guidance` plugin. A capable autonomous agent that reads GitHub/Wikipedia/tool output **needs** this; it also reinforces truth-boundary (a malicious source can't impersonate Hermes' own system content).
- **CVE fixes:** Starlette BadHost (CVE-2026-48710), urllib3, PyJWT.
- **Fail-closed approval-button auth** when no allowlist is set; secret redaction in debug dumps; host-metadata withheld from public status; **memory/skill write-approval gate**.
- **Managed scope** (v0.17): administrator-pinned, user-immutable config & secrets from a root-owned `/etc/hermes`. Maps to "the dispatch guardrail must be tamper-resistant" and hardened prod.

---

## 4. Where upstream now overlaps what you built — **BORROW, don't replace**

Upstream's Kanban became a multi-agent platform (auto-decompose on triage, `hermes kanban swarm` = root + parallel workers + gated verifier + gated synthesizer + shared blackboard, per-task model overrides, worktree-per-task, scheduled starts, claim TTL, respawn guards, `max_in_progress`, `/workers/active` · `/runs/{id}` · `/inspect` · `POST /runs/{run_id}/terminate`).

This **validates your design** — it's the same shape as O1–O5 — but you should **keep yours**, because:
- Your guardrail (fail-closed allowlist, per-day/per-repo budgets, 4h autopilot cap, always-escalate-high-risk, HALT_FILE tiering, D3 anomaly auto-pause) has **no upstream equivalent**.
- Your board carries **truth-boundary signaling** and your 8-lane pipeline; upstream's dashboard doesn't.
- Codex-owns-chain routing + the two-repo split are Averray-specific.

**What to borrow (patterns, not a swap):**
- **Verifier/synthesizer swarm topology** as a shape for a future "decompose one goal into a routed task tree" (your P4 auto-decompose), driven by *your* dispatch guardrail.
- **Worker-visibility endpoint shape** (`/runs/{id}`, `/inspect`) if you extend runner introspection.
- The **elicitation** pattern (§2.5) for inline approvals instead of lane-parking.

> Net: adopting upstream Kanban wholesale would be a **regression** (loss of guardrails) dressed as an upgrade. Borrow the ideas; keep the plane.

---

## 5. What to SKIP (not relevant to a headless server orchestrator)

Real features, but not for our use case: the **native Desktop app** (Electron GUI), **iMessage/Photon**, **WhatsApp/Telegram/Discord/Signal/Matrix** and other messaging gateways, **voice/TTS**, **image generation + editing**, desktop pets, VS Code Marketplace themes. (One exception worth noting: the **web dashboard admin panel** could reduce SSH-and-edit-`config.yaml` ops toil, but it overlaps our own monitor and isn't a priority.)

---

## 6. Risks & upgrade cost — why "refresh intentionally" is right

Your `.env.example:10` already says *"Refresh intentionally after testing a new Hermes release."* Concretely, a v0.14→v0.17 bump carries:

1. **Three "god-file" refactors** (`run_agent.py` 16k→3.8k, `cli.py`, `gateway/run.py`) — claimed behavior-compatible, but large churn. Smoke the MCP tool surface end-to-end.
2. **s6 Docker supervision changes container boot.** Your compose runs `dashboard --host 0.0.0.0 --port 9119 --insecure` directly; upstream now auto-redirects `gateway run` to supervised mode. **Verify the `hermes`, `hermes-gateway`, and dashboard services still start under your compose invocation.**
3. **⚠ #464 coupling (see §3.1)** — re-verify skills-volume ownership vs `user: "10000:10000"`.
4. **Removed/moved defaults:** the agent-callable **`send_message` tool was removed** (v0.17); several bundled skills were dropped or moved to optional. **Confirm nothing you rely on vanished** (esp. anything your skills/prompts assume).
5. **Model:** confirm `deepseek-v4-pro:cloud` via ollama-cloud still resolves; consider adding a fast model for triage.
6. **Pin discipline:** bump to a **specific digest** (`v2026.6.19`), never `:latest`/`:main` in prod.

---

## 7. Recommended path (each step a narrow PR / reversible)

1. **Staging smoke on a throwaway profile** — pull `nousresearch/hermes-agent:v2026.6.19`, run it under a second profile/compose project, and check: MCP tools connect (`averray`, `wallet`, `receipt`, `trace`, `policy`), a skill write lands, the gateway API answers, and **re-verify the skills-volume ownership vs #464**. Output: a go/no-go with the exact ownership + boot findings.
2. **Config-only wins (no bump needed to decide, applied with it):** `curator.consolidate: false` (zero-token routine); add a fast triage model alongside deepseek-v4-pro.
3. **Bump the pinned digest** once staging is green; the ops/security hardening (§3) rides along.
4. **Brain integration (the agentic leap), in order of leverage:** (a) move the orchestration/co-pilot loop onto the **Session API + SSE** (§2.2); (b) wire **background subagents** into Hermes's planner path (§2.1); (c) evaluate **MCP elicitation** for inline approval gates (§2.5).
5. **Borrow, later:** swarm-topology decomposition as a shape for P4 auto-decompose — *inside* your existing dispatch guardrail.

---

## 8. Open decisions for the operator

1. **How aggressive on the bump?** Staged-with-smoke (recommended) vs. wait for a specific feature vs. hold at v0.14.
2. **Session API vs. SSH** — commit to moving the orchestration loop to the gateway Session API? (Highest agentic leverage; medium effort.)
3. **Background subagents** — do we want Hermes fanning out its own parallel work, and if so, does that spend count against the dispatch budget?
4. **Elicitation for approvals** — inline MCP confirmation vs. keeping the lane-park approval model.

---

## Appendix — plan §3 "[assumed]" capabilities, confirmed against v0.17

| Plan §3 assumption | v0.17 reality |
|---|---|
| Agent loop + tool calling | ✅ + hardened (progressive disclosure, execution-guidance, promptware defense) |
| Subagent spawning | ✅ **now background/async, uncapped depth, no default timeout, watch-windows** |
| Cron scheduler | ✅ **pluggable CronScheduler + managed scale-to-zero + Automation Blueprints** |
| Skills framework | ✅ **bundles, `environments:` gate, curator prunes built-ins, zero-token routine** |
| Memory (FTS5 + summary + profile) | ✅ **atomic batch ops; `session_search` 4,500× faster/free; more backends** |
| MCP client + terminal backends | ✅ **elicitation, mTLS, progressive disclosure, exfil guards, Session API** |
| Messaging gateways | ✅ expanded (not relevant to us) + **remote-gateway OAuth** |

*End of eval. Recommendation only — not approved implementation.*

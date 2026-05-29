# Worker Model Auth & Billing (Claude / Codex)

- **Status:** Planning / handoff. Operational note for whoever builds **O2** (Claude worker) and **T4** (Tier-2 tester agent), and for the operator who provisions credentials.
- **Date:** 2026-05-29
- **Scope:** how the agent *workers* authenticate to their **model providers** (Anthropic / OpenAI) and how that **bills**. This is **not** product auth (that's SIWE via the signer sidecar — see `HERMES_TESTER_AUTH_DESIGN.md`) and **not** the dispatch guardrail (though the spend cap below *is* the budget half of AGENTS invariant #6).

> Time-sensitive: Anthropic unbundles programmatic Claude from the subscription on **June 15, 2026** (see below). Design O2/T4 for that reality, not for "free on the sub forever."

---

## Codex worker

Authenticates via **"Sign in with ChatGPT"** — usage is **included in the ChatGPT plan** (no per-token charge), or an OpenAI API key for metered billing. The current Codex worker uses the subscription path. ([Codex auth](https://developers.openai.com/codex/auth))

## Claude worker — three modes

1. **Subscription OAuth token** — `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Uses the Max plan.
   - **Until June 15, 2026:** programmatic `claude -p` / Agent SDK draws from the **existing sub usage pool** (already paid for → no extra charge).
   - **From June 15, 2026:** draws from a **separate monthly Agent SDK credit** (Pro $20 / Max 5× $100 / Max 20× $200, metered at API rates, **no rollover**), then API-rate overage if enabled.
2. **API key** — `ANTHROPIC_API_KEY`. Usage-based API spend. The **production / scale path** Anthropic recommends for shared/unattended automation.
3. **tmux-interactive (community workaround, NOT recommended here):** drive an *interactive* Claude Code session (which stays on the bundled sub pool) instead of a programmatic call. Cheapest, but fragile (send-keys/PTY scraping), gives **no clean structured output** (T4 needs the structured report), and straddles the interactive/programmatic line Anthropic is enforcing — ToS-gray. Documented for awareness; don't build the managed worker/tester on it.

### The June 15 split (why it matters)
**Interactive** Claude Code (terminal/tmux) stays on the sub. **Programmatic** (`claude -p`, Agent SDK, GitHub Actions, any harness — i.e. *our workers*) moves to the new credit pool. Both invocation modes we use are programmatic, so after June 15 they meter against the credit/API regardless. ([Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))

### Two footguns to guard
- **Key precedence:** auth order is API key **>** `CLAUDE_CODE_OAUTH_TOKEN` **>** interactive login. If `ANTHROPIC_API_KEY` is set in the worker env, it **silently wins and bypasses the sub** → API billing. For sub billing, ensure no `ANTHROPIC_API_KEY` in that worker's environment. ([Claude Code auth](https://code.claude.com/docs/en/authentication))
- **Silent-billing bug:** `claude -p` headless has routed to API billing for some users **even with no key set**. → mandatory route check (below).

---

## Policy: "sub now → API key at scale"

| Phase | Auth | Cost |
|---|---|---|
| Now / dev / low-volume (next ~2 weeks) | Claude: sub OAuth token (no API key in env). Codex: ChatGPT sub. | **~$0 extra** — bundled in existing subs; from June 15 the $100/$200 credit covers low volume. |
| Autopilot / higher volume / production | API key + **spend cap** (Console) | metered, predictable, capped; clean ToS for shared automation. |

**Cost projection (next 2 weeks): ~$0 extra**, running on the subs — provided the route is verified (footguns above) and you stay within Max usage limits (subs throttle, they don't surprise-bill). Autopilot (O4) isn't built yet, so volume is manual-dispatch-bounded. *Metered-equivalent would plausibly be low-tens-of-dollars to ≈$100 worst case (Opus, no caching, many reruns) — but it's moot on the sub.*

---

## Implementation requirements (O2 / T4)

- **Support both Claude modes**, env-driven (`CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_API_KEY`); default to sub OAuth for now.
- **Route-verification health check on worker startup** — assert the *intended* route is the *active* one (e.g. equivalent of `claude /status`; if intending sub but `ANTHROPIC_API_KEY` is present in the env, **fail loud**, don't silently API-bill). This defuses both footguns.
- **Spend cap when on API key** — set a Console cap per runner; this is the budget half of AGENTS invariant #6 (new power ⇒ allowlist + **budget** + human approval).
- **Operator provisions tokens/keys**; agents never handle the secret. Never log tokens/keys (existing invariant; output sanitization is a backstop, not a license).
- **Do this now (O2 is in build):** run `claude /status` + check `echo $ANTHROPIC_API_KEY` in the worker env to confirm you're not already silently API-billing.

## Sources
[Claude Code auth](https://code.claude.com/docs/en/authentication) · [Claude Code headless](https://code.claude.com/docs/en/headless) · [Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) · [Codex auth](https://developers.openai.com/codex/auth) · [Codex pricing](https://developers.openai.com/codex/pricing)

---

*Operational note. The June 15 2026 figures are from Anthropic docs (a change dated after this note); verify current terms in the Console before relying on exact credit amounts.*

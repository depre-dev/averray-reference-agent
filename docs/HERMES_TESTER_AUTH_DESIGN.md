# Hermes E2E Tester — Auth & Session Layer (build spec for steps 2–3)

- **Status:** Planning / handoff only. **Nothing here is implemented.**
- **Date:** 2026-05-29
- **Companion to:** [`HERMES_E2E_TESTER_DESIGN.md`](./HERMES_E2E_TESTER_DESIGN.md) — this details build steps **(2) pre-seeded session** and **(3) signer sidecar + SIWE mission**, which are the keystone that lets the tester reach the authed product instead of only public pages.
- **Tests:** `averray-agent/agent` — SIWE auth (`/auth/nonce` → `personal_sign` → `/auth/verify` → JWT; roles `admin`/`verifier` pinned at sign-in via `AUTH_ADMIN_WALLETS`/`AUTH_VERIFIER_WALLETS`).

> **Two auth surfaces to remember:** the **API** uses a Bearer JWT; the **operator app UI** uses SIWE + a refresh cookie. So the sidecar must produce **both** an API token *and* a browser `storageState`.

---

## Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| 1 | Test wallets / roles | **Separate role wallets** — distinct `agent`, `admin`, `verifier` testnet wallets. Enables the full create→claim→submit→verify→payout loop *and* lets missions test role-gating (a plain agent hitting `/admin/jobs` → 403). |
| 2 | Session delivery | **Sidecar mints + caches** — the sidecar runs SIWE, caches each role's session until expiry, re-SIWEs when stale; missions request a ready session. Keys never leave the sidecar. |

---

## What already exists — reuse, don't rebuild

Most of this loop is already implemented across the two repos; the sidecar is mostly *wiring*, not new SIWE code.

| Need | Already exists | Where |
|---|---|---|
| Generate a wallet | viem `generatePrivateKey` → `.env` | `reference-agent/scripts/bootstrap-wallet.sh` (1 wallet today; extend to 3) |
| **SIWE sign-in** | `wallet_sign_siwe` + `siweLogin()` | `packages/wallet-mcp` + `mcp-common` — **the SIWE flow is built; reuse it per role** |
| Grant `admin`/`verifier` roles | env address lists | `AUTH_ADMIN_WALLETS` / `AUTH_VERIFIER_WALLETS` (platform `mcp-server/src/auth/config.js`) — one-time deploy env |
| The full loop, end to end | a working script | platform `mcp-server/src/demo/e2e-remote.js` (SIWE → create job → claim → submit → verify) — adapt it as the gold-path mission |
| Run **without funding** | sponsored gas | starter jobs set `requiresSponsoredGas: true` (ERC-4337 / Pimlico) → the loop runs with an *unfunded* wallet |

**The one external/manual bit — funding.** Polkadot Hub TestNet funds come from the **web faucet `faucet.polkadot.io`** (token **PAS**, rate-limited, manual — verified via the `polkadot-docs` MCP per AGENTS invariant #8). There's no clean programmatic auto-fund, so:

> **Use FIXED, pre-funded wallets — do not regenerate per run** (you'd hit the faucet rate limit). Fund the three role wallets **once** (or lean on **sponsored starter jobs** to skip gas funding entirely), then reuse them every run.

---

## The signer sidecar (build step 3)

A small service that owns the test wallet keys and hands out authenticated sessions — **the key never enters the model/agent context.**

- **Holds three FIXED testnet keys** (`agent`, `admin`, `verifier`) as managed secrets (env/secret store), localhost-only — generated **once** (extend `bootstrap-wallet.sh`), pre-funded once (or sponsored), and **reused every run** (never regenerated — the faucet is rate-limited). Least-privilege: each key maps to exactly its role.
- **Mints two session types per role:**
  - **API session** — **reuse the existing `siweLogin()` / `wallet_sign_siwe`** (don't reimplement SIWE): `/auth/nonce` → sign locally → `/auth/verify` → JWT. Used for the gold-path/API missions.
  - **Browser session** — drives the operator app's login in a headless browser with the wallet signer, captures the post-login Playwright **`storageState`** (cookies/localStorage). Used for authed surface sweeps + browser missions.
- **Caches + refreshes:** cache each `(role × session-type)` until near `AUTH_TOKEN_TTL_SECONDS` expiry; re-mint on expiry. Expose e.g. `GET /session/:role?type=api|browser → { token | storageState, roles, expiresAt }`.
- **Deploys as an `ops/` compose service**, bound to localhost on the test env, keys injected from the secret store. Never logs tokens or keys.

## Pre-seeded session in the runner (build step 2)

- The mission/runner accepts a **session input** (a role + its `storageState` and/or Bearer token). Browser missions pass `storageState` to `newContext({ storageState })`; API/gold-path missions attach the Bearer JWT.
- The **surface sweep (step 1)** extends to **authed operator routes** (overview, runs, sessions, receipts, treasury, disputes, policies, agents, audit-log, capabilities) using the `agent` (or `admin`) session.
- **Decoupled from the sidecar for landing:** step 2 can accept a **manually-provided** `storageState`/token (a path/secret) so authed sweep is unblocked immediately; step 3 then wires the sidecar as the automated source. (Honest staging: don't block authed coverage on the full sidecar.)

## SIWE mission + role-gating coverage (build step 3)

The payoff of separate role wallets — a mission that exercises auth as a first-class surface:
- **Happy path per role:** nonce → sign (via sidecar) → verify → Bearer; assert JWT issued with the expected role claims.
- **Role-gating (negative tests):** `agent` token → `POST /admin/jobs` → expect `403 missing_role`; `agent` → verifier-only action → `403`; no token on a protected route → `401` with the documented `requiredAction: wallet_sign_in` payload. These assert the product's authority model, not just the happy path.
- Records results in the existing structured mission report.

## Environment binding (carry the mutation profile through auth)

- The sidecar's available roles/sessions are **per-environment**. On **testnet**: all three roles, mutating missions allowed. On **mainnet** (later): only a **read-only `agent` session**; no `admin`/`verifier` minting, no mutating gold-path — enforced by the env→mutation-profile binding from the tester design, so a mutating authed mission against mainnet is structurally impossible.

## Build sequence

1. **Step 2 — pre-seeded session:** runner accepts a session input; authed routes join the surface sweep; works with a manually-provided `storageState` first. *(One narrow PR.)*
2. **Step 3a — signer sidecar service:** a thin multi-role mint+cache service in `ops/` that **wraps the existing `siweLogin()`** for three **fixed, pre-funded** keys; keys isolated. Mostly wiring, not new SIWE. *(One narrow PR.)*
3. **Step 3b — SIWE mission + role-gating checks:** the auth mission that drives the sidecar and asserts happy-path + 401/403. *(One narrow PR.)*

## Security / invariants

- **Keys live only in the sidecar**, localhost-bound, least-privilege per role; never in the model context, never logged.
- **Testnet-only wallets**; no mainnet keys here. Mainnet sessions are read-only `agent` only.
- All of this stays under the same guardrail + `HALT_FILE`; tester missions still stop before any non-testbed mutation; merge/deploy stays human.

---

*End of tester auth/session design. Planning/handoff only — not implemented.*

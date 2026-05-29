<!--
PR notes per AGENTS.md. Keep PRs narrow — one task per PR.
Delete sections that genuinely don't apply.
-->

## What changed & why


## Affected surfaces
<!-- check all that apply -->
- [ ] MCP servers (averray / wallet / receipt / trace / policy)
- [ ] Monitor board / slack-operator
- [ ] Worker runners / task queue
- [ ] ops / compose / Dockerfile / Hermes image pin
- [ ] Database migrations
- [ ] Secrets / config / env
- [ ] Docs / tests only

## Checks run
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `docker compose --env-file ops/.env.example -f ops/compose.yml -f ops/compose.prod.yml config` (only if ops/Docker/compose touched)

## Rollout / rollback
<!-- Required when ops, compose, migrations, the Hermes pin, or secret/config surfaces change. -->


## Durable invariants (AGENTS.md)
- [ ] No auto-merge / auto-deploy — a human still owns the gate
- [ ] Wallet remains testnet-only; `HALT_FILE` honored; no new **ungated** agent power (new capability ⇒ new allowlist + budget + human approval)
- [ ] No secrets committed/printed/logged
- [ ] Updated `AGENTS.md` / affected docs **if this changes how agents work**

## Known limits / follow-ups


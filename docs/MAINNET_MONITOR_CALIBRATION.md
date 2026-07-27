# Mainnet monitor calibration

This packet calibrates the reference-agent board for Polkadot Hub mainnet
without weakening any health condition. The live values are versioned in
`ops/.env.mainnet-monitor.example`; operators copy them into the root
`.env.prod` and force-recreate only `slack-operator`.

The generic Compose defaults remain suitable for testnet. In particular, the
mainnet RPC endpoints and the intentionally-zero treasury floor are never
selected implicitly.

## Decisions

- The owner/treasury multisig intentionally holds no USDC float. Mainnet payouts
  come from the signer reward-bank position in AgentAccountCore, so the
  treasury reserve floor is `0` with a mandatory, operator-visible reason.
- The monitor samples every five minutes rather than every two minutes.
- The official `services.polkadothub-rpc.com/mainnet` endpoint is the primary
  monitor RPC. The former `eth-rpc.polkadot.io` primary remains a same-chain
  backup, and read-only RPC auto-remediation is enabled.
- Health-transition narration observes the same thirty-minute cooldown as
  product-health alerts. Probe state remains live on the board during cooldown.
- GitHub monitor enrichment gets five seconds. A bad credential must still be
  rotated; a larger timeout is not an authentication workaround.

## GitHub credential boundary

The two reported GitHub symptoms do not share a credential path in code:

- `github_pr_enrichment` runs in this repository's `slack-operator` container
  and resolves `GITHUB_REPO_TOKENS`, then `GITHUB_OWNER_TOKENS`, then
  owner/repository-specific environment variables, then `GITHUB_TOKEN`.
- Averray platform `github_ingest` runs in the platform backend and uses its own
  backend ingestion secret.

Rotate or repair each credential in its owning stack. A `401 Bad credentials`
from platform ingestion cannot be fixed by changing only the reference-agent
token, and a 2500 ms reference-agent timeout is not evidence of a 401.

## Rollout

1. Verify the root `.env.prod` selects the mainnet board before applying the
   overlay. Never print the env file or any token.
2. Copy the exact non-secret assignments from
   `ops/.env.mainnet-monitor.example` into `.env.prod`.
3. Render Compose and confirm the `slack-operator` environment contains the
   expected values:

   ```sh
   docker compose -p avg --env-file .env.prod \
     -f ops/compose.yml -f ops/compose.prod.yml config
   ```

4. Force-recreate the monitor so it re-reads `.env.prod`:

   ```sh
   docker compose -p avg --env-file .env.prod \
     -f ops/compose.yml -f ops/compose.prod.yml \
     up -d --build --force-recreate slack-operator
   ```

## Thirty-minute acceptance sample

Capture one continuous sample after the recreated container is healthy:

```sh
docker compose -p avg --env-file .env.prod \
  -f ops/compose.yml -f ops/compose.prod.yml \
  logs --since 30m slack-operator
```

The sample passes only when:

- no `treasury_liquidity` detail reports `reserve 0.00 < 5`;
- no product-health narration oscillates red → recovered → red;
- no probe detail contains HTTP `429`;
- `signer_liquidity` still reports DOT gas and the AgentAccountCore reward bank;
- the treasury row states that the zero reserve is intentionally unfunded and
  includes the declared reason.

If the official primary also starts throttling, keep the condition alertable
and provision a keyed same-chain RPC. Do not lower other floors or suppress RPC
errors.

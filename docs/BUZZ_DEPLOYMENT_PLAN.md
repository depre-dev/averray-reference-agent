# Buzz — deployment plan

Decision (2026-08-01): stand Buzz up, and give it a concrete first job rather
than justifying it in the abstract. That job is **ops narration**, which is
already built and currently going nowhere.

Everything below is from the upstream source, not from memory or docs prose —
`block/buzz`, `deploy/compose/`, `crates/buzz-relay/src/handlers/ingest.rs`.

---

## What Buzz actually is

A Nostr relay written in Rust — "a hive mind communication platform". Actively
developed (pushed the day this was written), 20k stars, public images at
`ghcr.io/block/buzz`.

Agent concepts are first-class in the protocol, not bolted on. The event-kind
list includes `KIND_MANAGED_AGENT`, `KIND_AGENT_PROFILE`, `KIND_AGENT_TURN_METRIC`,
`KIND_APPROVAL_GRANT` / `KIND_APPROVAL_DENY`, and `KIND_WORKFLOW_TRIGGER`. The
approval kinds matter to us: an authorize-this-action flow is a protocol
primitive here, which is exactly the control-plane property that justified Buzz
over "a nicer notification channel".

## What it costs

`deploy/compose/` is a first-party **single-node VPS bundle** (explicitly not
the repo's local-dev compose). `cp .env.example .env`, edit every `CHANGE_ME`,
`./run.sh start`.

Containers: **relay + Postgres + Redis + MinIO**, plus **Caddy** if it
terminates TLS. So four or five, on a box already running the averray stack,
Hermes, and a Postgres.

Requires Docker Compose ≥ **2.24.4** (the TLS override uses `!reset`).

## What it needs that we have to decide

**1. A hostname — RESOLVED.** `buzz.averray.com` has no DNS record today, so it
is free. `monitor.averray.com` answers with `server: cloudflare` + a `cf-ray`,
and the origin is the VPS at `141.94.121.188` — so the house pattern is
Cloudflare-proxied, TLS terminated at the edge.

Follow it: `buzz.averray.com` proxied to the VPS, Buzz listening on
`BUZZ_HTTP_PORT=3000`. `BUZZ_COMPOSE_TLS` stays **off** — no second Caddy, no
contest for 80/443 with whatever holds them now.

**2. Cloudflare Access — RESOLVED: do NOT put it in front of the relay.**
Buzz is a Nostr relay spoken over `wss://` by bots and desktop clients that have
no browser session. Access would reject all of them, and it would fail looking
like the app is broken rather than like an auth policy — the same shape as the
env-scoped-secret footgun.

It is also redundant, which is the deciding argument. Buzz authenticates
participants itself: `BUZZ_REQUIRE_AUTH_TOKEN=true`,
`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, and closed-relay mode keyed on
`RELAY_OWNER_PUBKEY`. Membership is by Nostr key. Fronting that with a second,
browser-shaped auth layer breaks the working one to duplicate it.

So: Cloudflare **proxied** (TLS + DDoS) but **not Access**, with Buzz's own
closed-relay mode carrying authorization. That is a real decision to make
deliberately, not a default to inherit.

**3. Memory headroom — MEASURED, and it fits.** 22 GiB total, 3.2 GiB used,
**19 GiB available**; disk 131 GiB free of 193. Buzz's four containers want
1–2 GiB at this scale. Not close to tight.

But **swap is 0**. There is no cushion: a spike is not slowness, it is an
immediate OOM kill — and this box also runs the monitor that watches the money
path. A Buzz problem must not be able to kill it.

So set explicit `mem_limit` on every Buzz service. Not because the box is
short, but because unbounded neighbours plus no swap is exactly how the thing
meant to warn you dies alongside the thing it watches.

**4. Image pin.** The example defaults to `ghcr.io/block/buzz:main`, which the
README itself calls "for early testing".

The relay versions independently of the desktop app, and the two are easy to
confuse: the release list is almost entirely `Buzz Desktop` (`v0.5.3`, `v0.5.2`
…). The Docker workflow only publishes `:latest` on a `relay-v*` tag, and there
are exactly **two** of those:

| git tag | date | commit |
|---|---|---|
| `relay-v0.1.1` | 2026-06-25 | `68a0cc8` |
| `relay-v0.2.0` | 2026-07-10 | `0d9be2f` |

**The git tag is NOT the image tag.** The workflow strips the `relay-v` prefix,
so `ghcr.io/block/buzz:relay-v0.2.0` 404s. Verified against the registry
directly rather than inferred:

```
relay-v0.2.0  404      ← the obvious guess, and wrong
0.2.0         200      ← the actual pin
v0.5.3        404      ← Desktop ships no relay image, confirming the two
                         product lines really are separate
main/latest   200
```

So the relay's newest release is **v0.2.0, three weeks old**, while `main` moves
daily (HEAD `3d7712c`, same day this was written). That gap is the actual
decision:

- **`relay-v0.2.0`** — released, stable, but three weeks behind a fast-moving
  young project, and features we may want (agent kinds, approval flow) could
  postdate it.
- **`:sha-3d7712c`** — current, and immutable once pinned. Not blessed as a
  release.

Recommendation: **`BUZZ_IMAGE=ghcr.io/block/buzz:0.2.0`** for P1. If something we
need postdates it, move to a named `:sha-<7>` deliberately — never `:main`,
which upgrades itself under a running integration.

## Integration: how narration reaches Buzz

`ingest.rs`: *"Both WebSocket `["EVENT", ...]` and HTTP `POST /events` feed into
`ingest_event` — two doors, one room."*

So HTTP works, but events are **Nostr events** — `verify_event` runs on ingest,
so they must be signed. Posting is therefore:

1. a bot keypair for Hermes (Nostr secp256k1, 64-hex)
2. a signing client in the monitor — `nostr-tools` or equivalent, one small dep
3. publish a stream-message kind to a channel, signed as the bot

`decideOpsNarration` already produces the text and already decides *when* — edge
-triggered across the red boundary, self-deduped, mute-gated, network-toned. It
needs a transport, not a rewrite. `recordCollaborationMessage` becomes a second
sink alongside (or replaced by) a Buzz publish.

**Alert dedup stays in our code**, never in the relay. `payout:${gap}` is keyed
the way it is for a reason (the detail string carries drifting USDC totals);
handing that judgement to a message bus re-opens a fixed bug.

## Phasing

**P1 — stand it up, empty.** Compose bundle on the VPS, pinned image, reached
only through the tunnel, `BUZZ_AUTO_MIGRATE=true` for the first boot. Nothing
integrated. Confirms capacity and networking before any code depends on it.

The relay publishes NO host port, so verify from inside its network:

```bash
docker run --rm --network buzz_buzz-net curlimages/curl -fsS http://relay:3000/_liveness
curl -fsS https://buzz.averray.com/_liveness      # and through the tunnel
```

Run them separately: the first proves the relay booted, the second proves the
tunnel route and the shared-network attachment. First passes and second does
not → the fault is networking, not Buzz.

**P2 — the bot can speak.** Bot keypair, signing client in slack-operator,
publish one hand-triggered test message. Proves the whole path with no
behavioural change to the monitor.

**P3 — narration lands.** Point `decideOpsNarration` at it. This is the first
thing that is *live* rather than demonstrated, and it makes an already-built,
already-tested, currently-inert feature real.

**P4 — Hermes reads and answers there.** Separate work; see
[[project_hermes_buzz_architecture]]. Read-only first, allowlist deferred.

> **⚠ SUPERSEDED — STATUS AS OF 2026-08-04. P4 IS LIVE AND NOT READ-ONLY.**
>
> `BUZZ_INBOUND_ENABLED=true`, `BUZZ_INBOUND_REQUIRE_MENTION=true`,
> `BUZZ_INBOUND_MAX_REPLIES_PER_HOUR=10`. A question in the ops channel is
> handed to a **full Hermes session with its whole tool surface** — the guards
> in `buzz-inbound.ts` (SELF / ECHO / RATE / mention) are anti-loop and
> anti-spam, **not authority**. Authority lives downstream in
> `hermes/config/policy.yaml` and averray-mcp's mutation policy.
>
> **"Allowlist deferred" is misleading and was never actioned as written** — it
> was *delegated to the relay*, which runs closed: verified on the live relay
> 2026-08-04, `BUZZ_REQUIRE_AUTH_TOKEN=true`, `BUZZ_ALLOW_NIP_OA_AUTH=true`,
> `RELAY_OWNER_PUBKEY` set. Membership by issued credential IS the allowlist,
> exactly as §"redundant" above argued it should be. The posture is sound; the
> sentence describing it was not.
>
> Residual, and operator knowledge rather than config: **who holds issued relay
> credentials.** `REQUIRE_AUTH_TOKEN=true` says a credential is needed, not how
> many exist.
>
> **DO NOT enable Hermes v0.20.0's bundled Buzz gateway platform.** It is a
> second Buzz→agent path answering only to Hermes's own allowlist, bypassing the
> ops-channel scoping, mention requirement and rate limit above. Two paths with
> different gates is how the strict one becomes optional (AGENTS.md invariant
> #6). Keep it as a fallback if our client ever needs replacing.

## Risks worth naming up front

- **Second Postgres.** We already run one. Two database servers on one small box
  is the most likely resource problem, and the least visible until it bites.
- **`:main` drift.** An unpinned relay upgrading itself under a running
  integration is how a working path breaks overnight.
- **Nostr key management.** A bot private key is a credential. It belongs
  wherever the other prod secrets live, not in compose.
- **It solves nothing on its own.** Standing Buzz up changes no operator
  outcome until P3. If we stop after P1 we have added four containers and gained
  a liveness endpoint.

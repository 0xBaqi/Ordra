# Ordra

An enforcement gateway for AI agents on **Concordium testnet**. It sits in front of an API, checks the calling agent's
"Verified by Concordium" badge against the CIS-8004 Agent Registry, applies a policy, and allows or denies the call. Every decision
is written to an audit log.

Status: **slice 1**. One protected demo endpoint, header-based identity, no payments.

## How it works

```
agent --GET /protected, X-Agent-Token: <badge token address>--> Ordra Worker
   Ordra --check_badge(id, network:"testnet")--> Concordium Agent Registry MCP (hosted)
   Ordra: policy -> allow (200) | deny (401/403/503 + reason code)
   Ordra --> audit record (KV)
```

## Endpoints

| Route | What it does |
|---|---|
| `GET /protected` | Demo resource. Send `X-Agent-Token: <CIS-2 token address of the agent's badge>`. |
| `GET /audit?limit=20` | Most recent audit records, newest first (1 to 100). **Unauthenticated** in slice 1. |

```
curl -H 'X-Agent-Token: JyP9X5PpNatg3zfjCcn3S' http://localhost:8787/protected
```

## Policy (version `2026-11-24.1`)

Allow only if every check passes. Otherwise deny with the **first** failing root cause, in this order:

| # | Reason code | When | HTTP |
|---|---|---|---|
| 0 | `invalid_token` | header missing or not a base58 token address (checked before any registry call) | 401 |
| 1 | `untrusted_registry` | badge is not on the configured network + CIS-8004 contract (`testnet`, `12802,0`) | 403 |
| 2 | `not_found` | no agent record for this token | 403 |
| 3 | `revoked` | agent is not Active | 403 |
| 4 | `card_missing` | no agent card URL on chain | 403 |
| 5 | `card_unreachable` | card could not be fetched. Host down/timeout: retried once, then **retryable** (503 + Retry-After). Card URL 4xx: not retryable (403). | 503/403 |
| 6 | `hash_mismatch` | card was fetched and its SHA-256 differs from the on-chain hash | 403 |
| 7 | `badge_missing` | card carries no Concordium badge | 403 |
| 8 | `badge_invalid` | badge present but fails other checks (e.g. names a different agent's token) | 403 |
| - | `registry_unavailable` | registry unreachable, timeout, HTTP error, 429 | 503 |
| - | `registry_malformed` | response failed schema validation, tool error, or answered about another token | 503 |
| - | `audit_unavailable` | the decision could not be written to the audit log | 503 |

**Fail closed:** anything unexpected is a deny. `untrusted_registry` exists because the registry's `check_badge`
resolves the network from the token itself and ignores `network:"testnet"`. Without this check, a mainnet agent would pass
on a testnet gateway. See [docs/FINDINGS.md](docs/FINDINGS.md) §5a.

**What "verified" means here:** the badge proves the agent is registered, Active, owned by a Concordium account, and that
its card matches the hash committed on chain. It does **not** prove anything about who the owner is (no identity attributes).
The registry has no tool for that. See FINDINGS §5b.

## Caching and rate limits

Registry results are cached in memory per Worker isolate: 60 s for normal results, at most 5 s for failures and
`card_unreachable`. The cache is not shared across isolates or locations.

## Audit records

One JSON record per decision: `id`, `timestamp`, `token_address`, `decision`, `reason`, `retryable`, `detail`,
`policy_version`, `trust` (network + contract), `request`, and `registry` (`source` live/cache/none, `attempts`,
`fetched_at`, `outcome`, and the **full parsed `check_badge` result including every issue**). Stored in the `AUDIT` KV
namespace, with an in-memory fallback when no binding is present.

## Run it

```
npm install
npm test          # offline, no network
npm run typecheck
npm run build     # wrangler bundle, dry run, no deploy
npm run dev       # local Worker on :8787 (needs outbound access to agent-registry-mcp.concordium.com)
npm run probe -- --fixtures   # re-record registry fixtures (live network)
```

No secrets are needed. Config is in `wrangler.toml` `[vars]`; see `.dev.vars.example` for overrides.

## Deploy (Cloudflare Workers Builds, Git integration)

| Setting | Value |
|---|---|
| Worker name | `ordra` (must match `name` in `wrangler.toml`) |
| Production branch | `slice-1` until merged, then `main` (Settings → Build → Branch control) |
| Build command | `npm test` (a failing test blocks the deploy) |
| Deploy command | `npx wrangler deploy` |
| Root directory / Path | empty (repo root) |
| Variables | none; everything is in `wrangler.toml` `[vars]` |

Audit KV namespace: `ordra-audit` (`f1e53faecaec44c8a991fe46448cee7c`), bound as `AUDIT` in `wrangler.toml`.
Free-plan KV allows 1,000 writes/day, and every `/protected` request writes one audit record.

## Honest status

**Works, verified by running (2026-11-24):**
- 42 offline tests pass (`npm test`); typecheck and wrangler bundle pass.
- The gateway handler was run under Node against the **live testnet registry** for 12 real tokens. Each produced the expected
  decision: allow, `not_found`, `revoked`, `card_missing`, `card_unreachable` (host down and 404), `hash_mismatch`,
  `badge_missing`, `badge_invalid`, and `untrusted_registry` (mainnet badge and unknown contract). The second identical request was
  served from cache.
- `wrangler dev` (local workerd) starts, serves `/protected` and `/audit`, and writes to local KV. In the build sandbox
  workerd could not reach the internet, so every live check correctly **failed closed** with `registry_unavailable`.

**Mocked in tests:** the registry HTTP layer. Policy tests replay real recorded responses. Transport failures and broken payloads
are synthetic and labelled as such.

**Untested / assumed:**
- Not yet deployed to Cloudflare. Real KV latency and eventual consistency of `/audit` are untested.
- The registry's real rate limit (no 429 seen in ~150 calls).
- Fixtures depend on third-party agent cards and can drift if owners change them.
- `/audit` is public. It contains only public on-chain data, but anyone can read it.

**Not built yet (by design):** x402 payments, payer-wallet-to-agent resolution, spending policy, dashboard, multi-chain.

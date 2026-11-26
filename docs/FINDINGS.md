# Task 1 findings: Concordium Agent Registry MCP (hosted)

Probed on **2026-11-24** from a cloud sandbox. Every claim below is marked
**[verified]** (I ran it and saw the response) or **[unverified]**.
Raw responses: [`probe-output.json`](probe-output.json) and
[`../tests/fixtures/check_badge/`](../tests/fixtures/check_badge/).
Reproduce: `NODE_USE_ENV_PROXY=1 npx tsx scripts/probe.ts --fixtures`
(`NODE_USE_ENV_PROXY` is only needed behind an HTTPS proxy).

## 1. Endpoint

| Thing | Result |
|---|---|
| `GET /healthz` | `{"ok":true,"version":"0.1.0"}` [verified] |
| `POST /mcp` `initialize` | server `concordium-agent-registry-mcp` 0.1.0, protocolVersion **`2024-11-05`**, capabilities `{tools:{listChanged:false}}` [verified] |
| Transport | Plain JSON-RPC 2.0 over POST, `Content-Type: application/json` response (no SSE, no session header needed) [verified] |
| Auth | None needed [verified] |
| CORS | `access-control-allow-origin: *` [verified] |
| Rate limit | Docs say per-IP with 429 + `Retry-After`. ~80 calls in ~5 min never hit a 429, and no rate-limit headers appear on 200s [verified]. The actual limit is **unknown**. |
| REST twins | `GET /v1/check-badge/{id}`, `/v1/verify-agent-card/{token_address}`, `/v1/get-badge-json/{token_address}`, `/v1/build-set-agent-uri/{token_address}` (from `/openapi.json`) [verified exists; only `check-badge` HEAD tested] |
| Indexer | Enumeration/search lives on a separate host, `https://agent-registry-indexer.concordium.com/` (per openapi description) [unverified, not probed] |

## 2. Testnet: supported

**Yes.** Every tool takes an optional `network` argument:
`enum ["devnet","testnet","mainnet"]`, default `"mainnet"`. Pass
`"network":"testnet"` to select it [verified].

| | mainnet | testnet |
|---|---|---|
| gRPC node | grpc.mainnet.concordium.software:20000 | grpc.testnet.concordium.com:20000 |
| CIS-8004 (Agent Registry) contract | `10082,0` | **`12802,0`** |
| CIS-8 contract | `10081,0` | **`12801,0`** |
| CIS-8004 module ref | `0e5747…d3eb` | same module |
| Explorer | https://ccdscan.io | https://testnet.ccdscan.io |
| Indexer configured | yes | yes |
| Unavailable tools | none | none |

Testnet is live and busy: block height ~51,229,060, ~1,197 Active and 281
Revoked agents, latest registration (token 1477) at 2026-11-24 08:27 UTC [verified].

For `check_badge`, the network is **resolved from the token address** (contract
index is encoded in it), so omitting `network` for a testnet badge still
returned testnet data [verified on token 1477]. Ordra should pass
`network:"testnet"` explicitly anyway.

## 3. Tool list

41 tools [verified]. Read-only lookups: `agent_by_external_reference`,
`agent_by_token_address`, `agent_history`, `agent_of`, `agents_by_owner`,
`check_account_badges`, `check_badge`, `contract_info`, `get_agent_wallet`,
`get_agent_wallet_nonce`, `get_badge_json`, `get_metadata`, `is_active`,
`list_agents`, `network_status`, `owner_of_key`, `recent_registrations`,
`recent_transfers`, `search_agents`, `verify_agent_card`,
`agent_registry_capabilities`. Pure encoders: `parse_token_address`,
`token_address`. Transaction builders (`build_*`, `*_canonical_bytes`)
return unsigned payloads; Ordra does not need them for slice 1.

## 4. Exact schemas (from `tools/list`)

`network` below always means `{"type":"string","enum":["devnet","testnet","mainnet"],"default":"mainnet"}`, optional.
`token_id` always means `string matching ^[0-9]+$` **or** `integer >= 0`.
All schemas have `additionalProperties: false`.

| Tool | Required | Optional |
|---|---|---|
| `check_badge` | `id: string` (badge token address **or** account address, base58) | `network` |
| `is_active` | `token_id` | `network` |
| `agent_by_token_address` | `token_address: string` (Base58Check) | `network` |
| `agents_by_owner` | `owner_account: string` | `limit: int 1..1000 (500)`, `network` |
| `get_agent_wallet` | `token_id` | `network` |
| `verify_agent_card` | `token_id` | `fetch: bool (true)`, `network` |
| `network_status` | none | `network` |
| `contract_info` | none | `network` |
| `agent_registry_capabilities` | none | `network` |

Note the inconsistency: `check_badge` and `agent_by_token_address` key on the
**token address**; `is_active`, `get_agent_wallet`, `verify_agent_card` key on
**token_id**. `parse_token_address` converts address → `{contract_index, contract_subindex, token_id_hex, token_id_u64, token_id}` off-chain.

## 5. `check_badge` response shape (testnet, real)

Tool result is `result.content[0].text` = a JSON **string** to parse again.
Top-level fields: `token_id`, `token_address`, `agent_uri`, `http_status`
(card fetch), `card_sha256`, `on_chain{owner_account,status,agent_uri,metadata_hash_hex}`,
`checks{…}`, `badge_valid: bool`, `issues[{severity,field,message,expected?,actual?}]`,
`network`, `expected{chain,contracts}`.

`checks` **short-circuits**: later keys are absent when an earlier one fails.
Full key order seen: `on_chain_agent_found`, `status_active`, `has_agent_uri`,
`card_fetched`, `hash_matches_on_chain`, `badge_present`, `badge_embedding`,
`badge_well_formed`, `token_address_matches`, `owner_matches`,
`contracts_match`, `verify_present`, `extension_conformant`,
`verification_present`, `verify_url_matches`.

Recorded fixtures (all JSON-RPC `isError:false`, HTTP 200), re-recorded 2026-11-24:

| Fixture | Token | What the registry said | Ordra reason |
|---|---|---|---|
| `valid` | 1449 | all checks true, `badge_valid:true` | allow |
| `not_found` | 999999 (well-formed, no record) | `checks:{on_chain_agent_found:false}` | `not_found` |
| `revoked` | 15 | `status_active:false` (card also 404) | `revoked` |
| `no_agent_uri` | 1468 | `has_agent_uri:false`, checks stop | `card_missing` |
| `card_host_down` | 1191 | `card_fetched:false`, `http_status:null`, issue "could not fetch card: … error sending request" | `card_unreachable` (retryable) |
| `card_http_404` | 1184 | `card_fetched:false`, `http_status:404`, later checks still run (all false) | `card_unreachable` (not retryable) |
| `hash_mismatch` | 1455 | card fetched, `hash_matches_on_chain:false` | `hash_mismatch` |
| `badge_missing` | 1231 | hash true, `badge_present:false` | `badge_missing` |
| `badge_missing_and_hash` | 1450 | no badge **and** hash false | `hash_mismatch` (root-cause order) |
| `badge_token_mismatch` | 1453 | hash true, badge names another agent's token | `badge_invalid` |
| `mainnet_badge` | mainnet 10082 / token 1, sent with `network:"testnet"` | evaluated **on mainnet** (`network:"mainnet"`) | `untrusted_registry` |
| `unconfigured_contract` | contract 9999 / token 1 | different shape: `{token_address, badge_valid:false, checks:{contract_is_registry:false}, issues}`, no `network` | `untrusted_registry` |

### 5a. `network` does not pin the network for `check_badge` [verified]

A mainnet badge sent with `network:"testnet"` was evaluated against mainnet,
and the response said `network:"mainnet"`. The contract index inside the token
address wins. **A gateway that trusts `check_badge` alone would accept mainnet
agents on a testnet deployment (and the reverse).** Ordra therefore checks
`response.network` and `response.expected.contracts.cis8004` against its own
config and denies on mismatch.

### 5b. Does `badge_valid` include a verified identity of the owner? **No.**

- The badge's `verification` block is just pointers (`service`, `verifyUrl`,
  `mcp`, `docs`). The docs call them "Verification hints … the optional
  verification block names where to run them" and "Any issuer may point these"
  elsewhere. It is not an attestation. `verification_present` only checks that
  the block exists [verified in docs and in `get_badge_json` output].
- What a passing badge proves, quoting the badge docs: *"the agent is registered
  in the Agent Registry, is currently active, is owned by an accountable
  Concordium account, and that its published card is exactly the one committed
  on-chain."* So "Verified by Concordium" means "verified on-chain registration",
  not "verified human/company".
- Nothing in the 41 registry tools returns identity attributes or an identity
  proof for the owner [verified against `tools/list`]. Closest fields:
  `on_chain.owner_account` and `checks.owner_matches`.
- **[unverified, from general Concordium knowledge, not from these docs]**
  Every Concordium account is opened from an identity issued by an identity
  provider, which is what "accountable" refers to. Proving specific attributes
  (e.g. country, over-18, company) needs Concordium ID / Web3 ID
  zero-knowledge proofs presented by the owner's wallet. That is outside the
  registry and can't be done from a header-only gateway.
- Also from the docs: *"a badge qualifies as a Verified by Concordium badge
  whenever its contract implements"* CIS-8004, and verifiers must *"Confirm the
  contract … is a registry your application trusts."* Hence the trusted-contract
  check above.

## 6. Errors seen

- `check_badge` with a non-address string → `isError:true`, text
  `config error: \`notarealaddress\` is neither a CIS-8004 badge token address nor a Concordium account address`
  (not JSON) [verified]. JSON-RPC itself still returns 200 with a `result`.
- `token_address` with a missing `contract_index` → `isError:true`, `config error: contract_index must be u64` [verified].
- One transient: during a scan, token 1449 once came back without card checks
  (its card is on a free-tier host that cold-starts). Three later calls all
  returned full `badge_valid:true`. I did not save that body, so I can't say
  exactly what it contained. **Implication: `check_badge` fetches the
  off-chain card live on every call, so results depend on third-party
  uptime, not just the chain.**
- In this sandbox, Node's `fetch` needed `NODE_USE_ENV_PROXY=1`; curl did not.
  Sandbox-only, not a registry issue.

## 7. Facts from the brief vs reality

| Brief said | Reality |
|---|---|
| Docs only describe mainnet | Testnet is fully served via `network:"testnet"` |
| `check_badge` takes "token address or account" | Correct; the param is named `id` |
| 429 + Retry-After | Not observed; limit unknown |
| `is_active` etc. by token | They take `token_id`, not a token address |
| Testnet selected by `network` | True for most tools; **not** for `check_badge`, where the token's contract decides (5a) |
| Badge = verified identity | No: verified on-chain registration + card integrity only (5b) |

Policy decisions were made by the owner on 2026-11-24 (see README "Policy").

## 8. Answers from Concordium (Discord, 2026-11-26)

Reported by the registry team in reply to our questions. **Not independently verified** unless marked.

| Question | Reported answer | Effect on Ordra |
|---|---|---|
| Payer wallet → agent lookup | The contract has no index from agent wallet to agent, and several agents may share one wallet. | A wallet can't identify an agent. Ordra keeps keying on the explicit `X-Agent-Token`; don't design anything that infers the agent from a payer wallet. |
| `check_badge` and `network` | Intended and not silent: the response carries `network: "mainnet"` and a warning; the badge encodes its registry contract, so the network is a fact of the badge. A gateway must check it to reject cross-network badges. | Matches section 5a. **[verified]** the recorded `mainnet_badge` fixture has `network:"mainnet"`, a top-level `queried_network`, and a `severity:"warning"` issue on field `network`. Ordra's existing `response.network` / contract check is the right gate. |
| What a passing badge proves | Token exists and is Active; owner account controls it (CIS-2 ownership); card at `agent_uri` hashes to the on-chain anchor; the badge in the card names this token/owner. Nothing about who the owner is. | Matches section 5b. Keep the wording "verified agent", never "verified owner". |
| Owner identity | Every Concordium account descends from an identity-verified account (IDP), and a company identity is a known legal entity, so "registered by an identity-verified account" is checkable. Name/org is attested only if put in an external reference. | **[unverified]** We have not found a registry tool that returns this, and `check_badge` does not. Ordra makes no identity claim beyond "accountable Concordium account". |

Still unanswered: whether x402 settlement works on testnet.

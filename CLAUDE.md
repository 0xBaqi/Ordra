# Ordra: instructions for AI coding tools

Ordra is an enforcement gateway for AI agents: it sits in front of an API,
checks the calling agent against the Concordium Agent Registry (CIS-8004),
applies a policy, returns allow/deny, and audits every decision.
Built for the Concordium Trusted Agents Hackathon (deadline 2026-12-09 23:59 UTC).

## Rules

1. Testnet only. Pass `network: "testnet"` explicitly on every registry call.
2. Fail closed. If the registry is unreachable or returns something we can't
   parse, deny with `registry_unavailable`. Never allow on uncertainty.
3. No secrets, private keys or wallet seeds in the repo or logs. Config goes
   through wrangler vars/secrets; document keys in `.dev.vars.example`.
   Never commit `.dev.vars` or `.env*`.
4. Never guess MCP parameter names. Schemas are in `docs/FINDINGS.md` and
   `docs/probe-output.json`; re-run `scripts/probe.ts` if in doubt.
5. Test fixtures must be real recorded responses (`scripts/probe.ts --fixtures`)
   or clearly labelled synthetic data. Never invent token addresses or tx hashes.
6. Tests must not need live network. The registry client sits behind an
   interface; tests use a mock.
7. Don't deploy. Don't add unrequested features: no dashboard, multi-chain,
   x402, or spending policy until slice 1 works and the owner asks.
8. Keep the README honest: what works, what is mocked, what is untested.
9. Small commits on a feature branch; PR description must separate
   "verified by running" from "assumed".
10. Stop and ask the owner if registry behaviour contradicts these facts or a
    design choice would change the demo.

## Registry facts (verified 2026-11-24, see docs/FINDINGS.md)

- Hosted MCP: `https://agent-registry-mcp.concordium.com/mcp`, JSON-RPC 2.0,
  plain JSON responses, no auth, CORS open. Health: `/healthz`.
  REST twin: `GET /v1/check-badge/{id}`. OpenAPI: `/openapi.json`.
- Rate-limited per IP (429 + Retry-After per docs; limit unknown). Cache results.
- Testnet CIS-8004 contract `12802,0`, CIS-8 `12801,0`. Explorer: testnet.ccdscan.io.
- `check_badge({id, network?})`: the tool result is a JSON string in
  `result.content[0].text`. Has `checks{}` (short-circuits), `badge_valid`, `issues[]`.
  It fetches the off-chain agent card live, so results depend on card host uptime.
- `is_active`, `get_agent_wallet`, `verify_agent_card` take `token_id`, not a token address.
- x402 settlement on Concordium testnet: unverified. Don't build it yet.

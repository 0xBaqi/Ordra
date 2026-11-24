// Discovery probe for the hosted Concordium Agent Registry MCP server.
//
//   npx tsx scripts/probe.ts            # writes docs/probe-output.json
//   npx tsx scripts/probe.ts --fixtures # also records real check_badge responses
//                                       # into tests/fixtures/check_badge/*.json
//
// Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1.
// Everything written is a raw recorded response. Nothing is synthesised.
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.REGISTRY_BASE_URL ?? "https://agent-registry-mcp.concordium.com";
let id = 0;

async function rpc(method: string, params?: unknown) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep raw text */ }
  return { method, params, status: res.status, retryAfter: res.headers.get("retry-after"), body };
}

const call = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });

// Real badge token addresses chosen on 2026-11-24, one per policy outcome.
// All are on the testnet CIS-8004 contract 12802,0 unless noted.
// Card-dependent outcomes can change if an owner edits or re-hosts their card.
const FIXTURE_TOKENS: Record<string, string> = {
  valid: "JyP9X5PpNatg3zfjCcn3S",                 // token 1449: every check passes
  not_found: "JyP9V5dupAgxNyUmSS4CG",             // token 999999: well-formed address, no record
  revoked: "JyP9UApR1fgJJL79x1xQT",               // token 15: status Revoked
  no_agent_uri: "JyP9XSBy55NJpNBVtfGbb",          // token 1468: no card URL on chain
  card_host_down: "JyP9X3Cc8M1jCTQ4yUnR2",        // token 1191: card host does not answer
  card_http_404: "JyP9WuYEcAXEPajbuJtVX",         // token 1184: card URL returns 404
  hash_mismatch: "JyP9XBxhxjtF2k6M7i4x7",         // token 1455: card fetched, hash differs
  badge_missing: "JyP9XnysPNxrPSuLa2vVi",         // token 1231: hash ok, card has no badge
  badge_missing_and_hash: "JyP9X6VJJcPbt7uVQR95v",// token 1450: no badge AND hash differs
  badge_token_mismatch: "JyP9X9mk6gtPNVckgzyhx",  // token 1453: hash ok, badge names another token
  mainnet_badge: "Mf22oWt8BKonzdwrwFqCM",         // MAINNET contract 10082 token 1, sent with network:testnet
  unconfigured_contract: "KLLYYkKhESVcDPjy7nGZh", // contract 9999 token 1: not a registry the service knows
};

async function main() {
  const out: unknown[] = [];
  const health = await fetch(`${BASE}/healthz`);
  out.push({ method: "GET /healthz", status: health.status, body: await health.text() });
  out.push(await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ordra-probe", version: "0.1.0" },
  }));
  out.push(await rpc("tools/list"));
  for (const network of ["mainnet", "testnet"]) {
    for (const t of ["agent_registry_capabilities", "network_status", "contract_info"]) {
      out.push(await call(t, { network }));
    }
  }
  writeFileSync("docs/probe-output.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote docs/probe-output.json (${out.length} calls)`);

  if (process.argv.includes("--fixtures")) {
    mkdirSync("tests/fixtures/check_badge", { recursive: true });
    for (const [label, token] of Object.entries(FIXTURE_TOKENS)) {
      const r = await call("check_badge", { id: token, network: "testnet" });
      const fixture = { recorded_at: new Date().toISOString(), source: `${BASE}/mcp`, request: r.params, http_status: r.status, response: r.body };
      writeFileSync(`tests/fixtures/check_badge/${label}.json`, JSON.stringify(fixture, null, 2) + "\n");
      console.log(`fixture ${label}: HTTP ${r.status}`);
    }
  }
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });

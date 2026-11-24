// Fail-closed behaviour. Bodies here are SYNTHETIC unless noted: they model
// transport failures and broken payloads that we can't record on demand.
import { describe, expect, it } from "vitest";
import { fixture, get, makeDeps, replayFetch, tokenOf } from "./helpers";

const TOKEN = tokenOf("valid");
const rpc = (text: string, isError = false) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } }));

function mutated(mutate: (inner: any) => void) {
  const body: any = fixture("valid").response;
  const inner = JSON.parse(body.result.content[0].text);
  mutate(inner);
  return () => rpc(JSON.stringify(inner));
}

describe("registry_unavailable", () => {
  it.each([
    ["network error", () => { throw new TypeError("fetch failed"); }],
    ["timeout", () => { throw new DOMException("The operation timed out", "TimeoutError"); }],
    ["HTTP 500", () => new Response("oops", { status: 500 })],
    ["HTTP 429", () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } })],
  ])("%s", async (_label, step) => {
    const { deps } = makeDeps({ fetch: replayFetch(step as () => Response).fetch });
    const { res, body } = await get(deps, "/protected", TOKEN);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ decision: "deny", reason: "registry_unavailable", retryable: true });
  });
});

describe("registry_malformed", () => {
  it.each([
    ["non-JSON body", () => new Response("<html>")],
    ["JSON-RPC error", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }))],
    // Text recorded live on 2026-11-24 for check_badge({id:"notarealaddress"}).
    ["tool isError", () => rpc("config error: `notarealaddress` is neither a CIS-8004 badge token address nor a Concordium account address", true)],
    ["tool text not JSON", () => rpc("hello")],
    ["badge_valid missing", mutated((j) => delete j.badge_valid)],
    ["issues not an array", mutated((j) => (j.issues = "none"))],
    ["check missing mid-chain", mutated((j) => delete j.checks.hash_matches_on_chain)],
    ["check has wrong type", mutated((j) => (j.checks.status_active = "yes"))],
    ["answer for another token", mutated((j) => (j.token_address = "JyP9XBxhxjtF2k6M7i4x7"))],
  ])("%s", async (_label, step) => {
    const { deps } = makeDeps({ fetch: replayFetch(step as () => Response).fetch });
    const { res, body } = await get(deps, "/protected", TOKEN);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ decision: "deny", reason: "registry_malformed" });
  });

  it("badge_valid:true with an error issue is still denied", async () => {
    const step = mutated((j) => j.issues.push({ severity: "error", field: "x", message: "synthetic" }));
    const { deps } = makeDeps({ fetch: replayFetch(step).fetch });
    const { body } = await get(deps, "/protected", TOKEN);
    expect(body.reason).toBe("badge_invalid");
  });
});

describe("invalid_token", () => {
  it.each([
    ["missing header", undefined],
    ["empty", ""],
    ["not base58", "0OIl-not-valid"],
    ["account address (50 chars)", "4Vrg5rkHN7m2STNTgYAqrxHE1jMAhkeZZ3rfifmtattD9PE5dK"],
  ])("%s -> 401 without calling the registry", async (_label, token) => {
    const r = replayFetch("valid");
    const { deps } = makeDeps({ fetch: r.fetch });
    const { res, body } = await get(deps, "/protected", token);
    expect(res.status).toBe(401);
    expect(body.reason).toBe("invalid_token");
    expect(r.calls).toHaveLength(0);
  });
});

describe("routing", () => {
  it("404 for unknown paths, 405 for non-GET", async () => {
    const { deps } = makeDeps({ fetch: replayFetch("valid").fetch });
    expect((await get(deps, "/nope")).res.status).toBe(404);
    const { handle } = await import("../src/index");
    const res = await handle(new Request("https://ordra.test/protected", { method: "POST" }), deps);
    expect(res.status).toBe(405);
  });
});

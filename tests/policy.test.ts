// One test per reason code, driven by REAL recorded check_badge responses
// (tests/fixtures/check_badge, recorded by scripts/probe.ts --fixtures).
import { describe, expect, it } from "vitest";
import { fixture, get, makeDeps, replayFetch, tokenOf, type FixtureName } from "./helpers";

const cases: Array<[FixtureName, string | null, number]> = [
  ["valid", null, 200],
  ["not_found", "not_found", 403],
  ["revoked", "revoked", 403],
  ["no_agent_uri", "card_missing", 403],
  ["card_http_404", "card_unreachable", 403],
  ["hash_mismatch", "hash_mismatch", 403],
  ["badge_missing", "badge_missing", 403],
  ["badge_missing_and_hash", "hash_mismatch", 403], // root cause wins
  ["badge_token_mismatch", "badge_invalid", 403],
  ["mainnet_badge", "untrusted_registry", 403],
  ["unconfigured_contract", "untrusted_registry", 403],
];

describe("policy on recorded registry responses", () => {
  it.each(cases)("%s -> %s", async (name, reason, status) => {
    const { deps } = makeDeps({ fetch: replayFetch(name).fetch });
    const { res, body } = await get(deps, "/protected", tokenOf(name));
    expect(res.status).toBe(status);
    expect(body.decision).toBe(reason === null ? "allow" : "deny");
    expect(body.reason).toBe(reason);
  });

  it("allow returns the agent identity from the registry", async () => {
    const { deps } = makeDeps({ fetch: replayFetch("valid").fetch });
    const { body } = await get(deps, "/protected", tokenOf("valid"));
    expect(body.agent).toEqual({
      token_address: "JyP9X5PpNatg3zfjCcn3S",
      token_id: 1449,
      owner_account: "4Vrg5rkHN7m2STNTgYAqrxHE1jMAhkeZZ3rfifmtattD9PE5dK",
    });
  });

  it("sends check_badge with the exact schema from tools/list", async () => {
    const r = replayFetch("valid");
    const { deps } = makeDeps({ fetch: r.fetch });
    await get(deps, "/protected", tokenOf("valid"));
    expect(r.calls[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "check_badge", arguments: { id: tokenOf("valid"), network: "testnet" } },
    });
  });

  it("a 404 card is not retried and not marked retryable", async () => {
    const r = replayFetch("card_http_404");
    const { deps } = makeDeps({ fetch: r.fetch });
    const { body } = await get(deps, "/protected", tokenOf("card_http_404"));
    expect(body.retryable).toBe(false);
    expect(r.calls).toHaveLength(1);
  });
});

describe("card_unreachable (host down) retries once", () => {
  it("allows if the retry succeeds", async () => {
    // Same token on both calls: the retry gets the valid response. The valid
    // fixture is for a different token, so swap the token in the recorded body.
    const down = fixture("card_host_down");
    const r = replayFetch("card_host_down", () => new Response(JSON.stringify(withToken(fixture("valid").response, tokenOf("card_host_down")))));
    const { deps } = makeDeps({ fetch: r.fetch });
    const { res, body } = await get(deps, "/protected", down.request.arguments.id);
    expect(r.calls).toHaveLength(2);
    expect(res.status).toBe(200);
    expect(body.decision).toBe("allow");
  });

  it("denies as retryable after two failures, with Retry-After", async () => {
    const r = replayFetch("card_host_down", "card_host_down");
    const { deps } = makeDeps({ fetch: r.fetch });
    const { res, body } = await get(deps, "/protected", tokenOf("card_host_down"));
    expect(r.calls).toHaveLength(2);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(body).toMatchObject({ decision: "deny", reason: "card_unreachable", retryable: true });
  });
});

/** SYNTHETIC: a recorded body with its token address replaced. */
function withToken(body: any, token: string) {
  const inner = JSON.parse(body.result.content[0].text);
  inner.token_address = token;
  return { ...body, result: { ...body.result, content: [{ type: "text", text: JSON.stringify(inner) }] } };
}

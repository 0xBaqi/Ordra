import { describe, expect, it } from "vitest";
import { KvAuditStore, MemoryAuditStore, type KvLike } from "../src/audit";
import { POLICY_VERSION } from "../src/policy";
import { fixture, get, makeDeps, replayFetch, tokenOf } from "./helpers";

/** In-memory stand-in for a KV namespace (lexicographic list, like KV). */
class FakeKv implements KvLike {
  data = new Map<string, string>();
  async put(k: string, v: string) { this.data.set(k, v); }
  async get(k: string) { return this.data.get(k) ?? null; }
  async list({ prefix, limit }: { prefix: string; limit: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
    return { keys: keys.map((name) => ({ name })) };
  }
}

describe("audit log", () => {
  it("writes one record per decision with the full issues list", async () => {
    const audit = new MemoryAuditStore();
    const { deps } = makeDeps({ fetch: replayFetch("badge_token_mismatch").fetch, audit });
    const { body } = await get(deps, "/protected", tokenOf("badge_token_mismatch"));
    const [rec] = await audit.recent(10);
    const recorded = JSON.parse((fixture("badge_token_mismatch").response as any).result.content[0].text);
    expect(rec).toMatchObject({
      id: body.audit_id,
      timestamp: "2026-11-24T12:00:00.000Z",
      token_address: tokenOf("badge_token_mismatch"),
      decision: "deny",
      reason: "badge_invalid",
      policy_version: POLICY_VERSION,
      trust: { network: "testnet", registry_contract: "12802,0" },
      registry: { source: "live", attempts: 1, outcome: "ok" },
    });
    expect(rec!.registry.data!.issues).toEqual(recorded.issues);
    expect(rec!.registry.data!.issues.length).toBeGreaterThan(0);
  });

  it("records denials that never reached the registry, and cache hits", async () => {
    const audit = new MemoryAuditStore();
    const { deps } = makeDeps({ fetch: replayFetch("valid").fetch, audit });
    await get(deps, "/protected");
    await get(deps, "/protected", tokenOf("valid"));
    await get(deps, "/protected", tokenOf("valid"));
    const recs = await audit.recent(10);
    expect(recs.map((r) => [r.reason, r.registry.source, r.registry.attempts])).toEqual([
      [null, "cache", 0],
      [null, "live", 1],
      ["invalid_token", "none", 0],
    ]);
  });

  it("GET /audit returns newest first from KV and honours limit", async () => {
    const kv = new FakeKv();
    const { deps, clock } = makeDeps({ fetch: replayFetch("revoked", "valid").fetch, audit: new KvAuditStore(kv) });
    await get(deps, "/protected", tokenOf("revoked"));
    clock.t += 1000;
    await get(deps, "/protected", tokenOf("valid"));
    const all = await get(deps, "/audit");
    expect(all.body.records.map((r: any) => r.reason)).toEqual([null, "revoked"]);
    const one = await get(deps, "/audit?limit=1");
    expect(one.body.records).toHaveLength(1);
  });

  it("fails closed if the audit write fails", async () => {
    const broken = { write: async () => { throw new Error("KV down"); }, recent: async () => [] };
    const { deps } = makeDeps({ fetch: replayFetch("valid").fetch, audit: broken });
    const { res, body } = await get(deps, "/protected", tokenOf("valid"));
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ decision: "deny", reason: "audit_unavailable" });
  });
});

import { readFileSync } from "node:fs";
import { MemoryAuditStore, type AuditStore } from "../src/audit";
import { TtlCache } from "../src/cache";
import type { CachedOutcome, GatewayDeps } from "../src/gateway";
import { handle } from "../src/index";
import { McpRegistryClient, type RegistryClient } from "../src/registry";

export type FixtureName =
  | "valid" | "not_found" | "revoked" | "no_agent_uri" | "card_host_down" | "card_http_404"
  | "hash_mismatch" | "badge_missing" | "badge_missing_and_hash" | "badge_token_mismatch"
  | "mainnet_badge" | "unconfigured_contract";

interface Fixture {
  request: { arguments: { id: string } };
  response: unknown; // the raw JSON-RPC body recorded from the live registry
}

export function fixture(name: FixtureName): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/check_badge/${name}.json`, import.meta.url), "utf8"));
}

/** Token address a fixture was recorded for. */
export const tokenOf = (name: FixtureName) => fixture(name).request.arguments.id;

/** A fetch that replays recorded bodies (or custom responses) in order. */
export function replayFetch(...steps: Array<FixtureName | (() => Response | Promise<Response>)>) {
  const calls: unknown[] = [];
  let i = 0;
  const fn = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step === undefined) throw new Error("replayFetch: no steps");
    if (typeof step === "function") return step();
    return new Response(JSON.stringify(fixture(step).response), { status: 200 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function makeDeps(opts: { fetch?: typeof fetch; registry?: RegistryClient; audit?: AuditStore; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: Date.parse("2026-11-24T12:00:00Z") };
  let n = 0;
  const deps: GatewayDeps = {
    registry: opts.registry ?? new McpRegistryClient({ baseUrl: "https://registry.test", network: "testnet", timeoutMs: 1000, fetch: opts.fetch }),
    audit: opts.audit ?? new MemoryAuditStore(),
    cache: new TtlCache<CachedOutcome>(() => clock.t),
    trust: { network: "testnet", registryContract: "12802,0" },
    cacheTtlMs: 60_000,
    failureTtlMs: 5_000,
    now: () => clock.t,
    newId: () => `id-${++n}`,
  };
  return { deps, clock };
}

export async function get(deps: GatewayDeps, path: string, token?: string) {
  const headers: Record<string, string> = token === undefined ? {} : { "x-agent-token": token };
  const res = await handle(new Request(`https://ordra.test${path}`, { headers }), deps);
  return { res, body: (await res.json()) as Record<string, any> };
}

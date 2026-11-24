// Ordra Worker entry point.
//   GET /protected  demo resource, gated on X-Agent-Token
//   GET /audit      recent decisions, newest first (?limit=1..100)
import { KvAuditStore, MemoryAuditStore, type AuditStore, type KvLike } from "./audit";
import { TtlCache } from "./cache";
import { checkAgent, type CachedOutcome, type GatewayDeps } from "./gateway";
import { POLICY_VERSION } from "./policy";
import { McpRegistryClient } from "./registry";

export interface Env {
  AUDIT?: KvLike; // KV namespace binding; in-memory fallback when absent
  REGISTRY_URL?: string;
  NETWORK?: string;
  REGISTRY_CONTRACT?: string;
  CACHE_TTL_SECONDS?: string;
  FAILURE_CACHE_TTL_SECONDS?: string;
  REGISTRY_TIMEOUT_MS?: string;
  AUDIT_RETENTION_SECONDS?: string;
}

// Module scope = per isolate. Survives between requests on the same isolate.
const cache = new TtlCache<CachedOutcome>();
const memoryAudit = new MemoryAuditStore();

export function depsFromEnv(env: Env): GatewayDeps {
  const failureTtl = Math.min(num(env.FAILURE_CACHE_TTL_SECONDS, 5), 5); // never cache failures > 5s
  const audit: AuditStore = env.AUDIT
    ? new KvAuditStore(env.AUDIT, num(env.AUDIT_RETENTION_SECONDS, 0) || undefined)
    : memoryAudit;
  return {
    registry: new McpRegistryClient({
      baseUrl: env.REGISTRY_URL || "https://agent-registry-mcp.concordium.com",
      network: env.NETWORK || "testnet",
      timeoutMs: num(env.REGISTRY_TIMEOUT_MS, 10_000),
    }),
    audit,
    cache,
    trust: { network: env.NETWORK || "testnet", registryContract: env.REGISTRY_CONTRACT || "12802,0" },
    cacheTtlMs: num(env.CACHE_TTL_SECONDS, 60) * 1000,
    failureTtlMs: failureTtl * 1000,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  };
}

export async function handle(request: Request, deps: GatewayDeps): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });

  if (url.pathname === "/protected") {
    const result = await checkAgent(request.headers.get("x-agent-token"), { method: request.method, path: url.pathname }, deps);
    const base = {
      decision: result.decision,
      reason: result.reason,
      retryable: result.retryable,
      policy_version: POLICY_VERSION,
      audit_id: result.record.id,
    };
    if (result.decision === "allow") {
      const data = result.record.registry.data;
      return json({
        ...base,
        agent: { token_address: data?.token_address, token_id: data?.token_id, owner_account: data?.on_chain?.owner_account },
        resource: "Access granted. This is the protected demo resource.",
      }, 200);
    }
    const status = statusFor(result.reason);
    const headers: Record<string, string> = status === 503 && result.retryable ? { "retry-after": String(Math.max(1, deps.failureTtlMs / 1000)) } : {};
    return json({ ...base, ...(result.detail ? { detail: result.detail } : {}) }, status, headers);
  }

  if (url.pathname === "/audit") {
    const limit = Math.min(Math.max(Math.trunc(num(url.searchParams.get("limit") ?? undefined, 20)), 1), 100);
    try {
      return json({ records: await deps.audit.recent(limit) }, 200);
    } catch {
      return json({ error: "audit_unavailable" }, 503);
    }
  }

  return json({ error: "no_route" }, 404);
}

function statusFor(reason: string | null): number {
  switch (reason) {
    case "invalid_token":
      return 401;
    case "registry_unavailable":
    case "registry_malformed":
    case "audit_unavailable":
      return 503;
    case "card_unreachable":
      return 503;
    default:
      return 403;
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, depsFromEnv(env));
  },
};

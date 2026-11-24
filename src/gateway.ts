// Orchestration: token -> (cache | registry, retry once) -> policy -> audit.
import type { AuditRecord, AuditStore } from "./audit";
import { evaluate, POLICY_VERSION, type Decision, type TrustConfig } from "./policy";
import type { RegistryClient, RegistryOutcome } from "./registry";
import type { TtlCache } from "./cache";

export interface CachedOutcome {
  outcome: RegistryOutcome;
  fetchedAt: number;
}

export interface GatewayDeps {
  registry: RegistryClient;
  audit: AuditStore;
  cache: TtlCache<CachedOutcome>;
  trust: TrustConfig;
  cacheTtlMs: number; // allow and stable denials
  failureTtlMs: number; // registry failures and card_unreachable: keep short
  now: () => number;
  newId: () => string;
}

export interface GatewayResult extends Decision {
  record: AuditRecord;
}

// Base58 alphabet. CIS-2 token addresses seen so far are ~21 chars;
// account addresses are 50, and are rejected here on purpose.
const TOKEN_RE = /^[1-9A-HJ-NP-Za-km-z]{10,40}$/;

const TRANSIENT = new Set(["registry_unavailable", "registry_malformed", "card_unreachable"]);

export async function checkAgent(
  rawToken: string | null,
  req: { method: string; path: string },
  deps: GatewayDeps,
): Promise<GatewayResult> {
  const token = rawToken?.trim() ?? "";

  let decision: Decision;
  let source: AuditRecord["registry"]["source"] = "none";
  let attempts = 0;
  let cached: CachedOutcome | undefined;

  if (!TOKEN_RE.test(token)) {
    decision = { decision: "deny", reason: "invalid_token", retryable: false, detail: "X-Agent-Token missing or not a base58 token address" };
  } else {
    cached = deps.cache.get(token);
    if (cached) {
      source = "cache";
      decision = evaluate(cached.outcome, deps.trust);
    } else {
      source = "live";
      cached = await fetchOutcome(token, deps);
      attempts = 1;
      decision = evaluate(cached.outcome, deps.trust);
      if (decision.reason === "card_unreachable" && decision.retryable) {
        cached = await fetchOutcome(token, deps);
        attempts = 2;
        decision = evaluate(cached.outcome, deps.trust);
      }
      const ttl = decision.reason && TRANSIENT.has(decision.reason) ? deps.failureTtlMs : deps.cacheTtlMs;
      deps.cache.set(token, cached, ttl);
    }
  }

  const outcome = cached?.outcome;
  const record: AuditRecord = {
    id: deps.newId(),
    timestamp: new Date(deps.now()).toISOString(),
    token_address: token || null,
    decision: decision.decision,
    reason: decision.reason,
    retryable: decision.retryable,
    ...(decision.detail ? { detail: decision.detail } : {}),
    policy_version: POLICY_VERSION,
    trust: { network: deps.trust.network, registry_contract: deps.trust.registryContract },
    request: req,
    registry: {
      source,
      attempts,
      fetched_at: cached ? new Date(cached.fetchedAt).toISOString() : null,
      outcome: outcome?.kind ?? null,
      ...(outcome && outcome.kind !== "ok" ? { outcome_detail: outcome.detail } : {}),
      data: outcome?.kind === "ok" ? outcome.data : null,
    },
  };

  try {
    await deps.audit.write(record);
  } catch (err) {
    // Every decision must be auditable. If we can't record it, fail closed.
    console.error("audit write failed", err instanceof Error ? err.message : String(err));
    const failed: Decision = { decision: "deny", reason: "audit_unavailable", retryable: true };
    return { ...failed, record: { ...record, ...failed } };
  }
  return { ...decision, record };
}

async function fetchOutcome(token: string, deps: GatewayDeps): Promise<CachedOutcome> {
  let outcome = await deps.registry.checkBadge(token);
  // The registry must answer about the token we asked about.
  if (outcome.kind === "ok" && outcome.data.token_address !== token) {
    outcome = { kind: "malformed", detail: `registry answered for ${outcome.data.token_address}, asked about ${token}` };
  }
  return { outcome, fetchedAt: deps.now() };
}

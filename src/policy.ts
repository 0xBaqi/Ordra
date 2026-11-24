// Pure policy: registry outcome in, decision out. No I/O.
import type { RegistryOutcome } from "./registry";

// Bump when the rules below change. Stored in every audit record.
export const POLICY_VERSION = "2026-11-24.1";

export type ReasonCode =
  | "invalid_token" // header missing or not a base58 token address
  | "untrusted_registry" // badge is not from the configured network + CIS-8004 contract
  | "not_found"
  | "revoked"
  | "card_missing" // no agent_uri on chain
  | "card_unreachable" // agent card could not be fetched
  | "hash_mismatch" // card fetched, SHA-256 differs from on-chain metadata_hash
  | "badge_missing" // card has no Concordium badge
  | "badge_invalid" // badge present but fails other checks (e.g. names another token)
  | "registry_unavailable"
  | "registry_malformed"
  | "audit_unavailable"; // decision could not be written to the audit log

export interface Decision {
  decision: "allow" | "deny";
  reason: ReasonCode | null;
  retryable: boolean;
  detail?: string;
}

export interface TrustConfig {
  network: string; // e.g. "testnet"
  registryContract: string; // CIS-8004 contract as "index,subindex", e.g. "12802,0"
}

const deny = (reason: ReasonCode, retryable = false, detail?: string): Decision => ({
  decision: "deny",
  reason,
  retryable,
  ...(detail ? { detail } : {}),
});

// Root-cause order agreed with the owner. Each check must be explicitly
// true to continue; false denies with that reason; anything else
// (missing/odd) means we can't trust the response, so fail closed.
const ORDERED_CHECKS = [
  ["on_chain_agent_found", "not_found"],
  ["status_active", "revoked"],
  ["has_agent_uri", "card_missing"],
  ["card_fetched", "card_unreachable"],
  ["hash_matches_on_chain", "hash_mismatch"],
  ["badge_present", "badge_missing"],
] as const;

export function evaluate(outcome: RegistryOutcome, trust: TrustConfig): Decision {
  if (outcome.kind === "unavailable") return deny("registry_unavailable", true, outcome.detail);
  if (outcome.kind === "malformed") return deny("registry_malformed", false, outcome.detail);

  const d = outcome.data;
  const c = d.checks;

  // check_badge resolves the network from the token's contract and ignores
  // our `network` argument, so we must check the trust anchor ourselves.
  if (c.contract_is_registry === false) return deny("untrusted_registry", false, "contract is not a registry the service knows");
  if (d.network !== trust.network) return deny("untrusted_registry", false, `badge is on ${d.network ?? "unknown"}, expected ${trust.network}`);
  const contract = d.expected?.contracts.cis8004;
  if (contract !== trust.registryContract) {
    return deny("untrusted_registry", false, `registry contract ${contract ?? "unknown"}, expected ${trust.registryContract}`);
  }

  for (const [key, reason] of ORDERED_CHECKS) {
    const v = c[key];
    if (v === true) continue;
    if (v === false) {
      if (reason === "card_unreachable") {
        // No HTTP status = host down / timeout: worth retrying. 4xx = card gone.
        const s = d.http_status;
        const retryable = s == null || s >= 500 || s === 408 || s === 429;
        return deny(reason, retryable, s == null ? "card host did not respond" : `card URL returned HTTP ${s}`);
      }
      return deny(reason);
    }
    return deny("registry_malformed", false, `check ${key} missing from response`);
  }

  const hasErrorIssue = d.issues.some((i) => i.severity === "error");
  if (!d.badge_valid || hasErrorIssue) {
    const first = d.issues.find((i) => i.severity === "error");
    return deny("badge_invalid", false, first?.message);
  }
  return { decision: "allow", reason: null, retryable: false };
}

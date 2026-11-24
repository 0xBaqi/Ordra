// Schema for the JSON inside a check_badge tool result.
// Derived from real recorded responses in tests/fixtures/check_badge/.
// Unknown extra fields are kept (looseObject) so a new registry field never
// breaks parsing, but every field the policy reads is typed and validated.
import { z } from "zod";

const Issue = z.looseObject({
  severity: z.string(),
  field: z.string().optional(),
  message: z.string(),
});

const Checks = z.looseObject({
  contract_is_registry: z.boolean().optional(),
  on_chain_agent_found: z.boolean().optional(),
  status_active: z.boolean().optional(),
  has_agent_uri: z.boolean().optional(),
  card_fetched: z.boolean().optional(),
  hash_matches_on_chain: z.boolean().optional(),
  badge_present: z.boolean().optional(),
});

const OnChain = z.looseObject({
  owner_account: z.string(),
  status: z.string(),
  agent_uri: z.string().nullable(),
  metadata_hash_hex: z.string().nullable(),
});

export const CheckBadgeResult = z.looseObject({
  token_address: z.string(),
  token_id: z.number().int().nonnegative().optional(),
  network: z.string().optional(),
  agent_uri: z.string().nullable().optional(),
  http_status: z.number().int().nullable().optional(),
  card_sha256: z.string().nullable().optional(),
  on_chain: OnChain.nullable().optional(),
  checks: Checks,
  badge_valid: z.boolean(),
  issues: z.array(Issue),
  expected: z
    .looseObject({
      chain: z.string(),
      contracts: z.looseObject({ cis8004: z.string(), cis8: z.string() }),
    })
    .optional(),
});
export type CheckBadgeResult = z.infer<typeof CheckBadgeResult>;

// JSON-RPC 2.0 envelopes for tools/call.
export const ToolCallSuccess = z.looseObject({
  jsonrpc: z.literal("2.0"),
  result: z.looseObject({
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).min(1),
    isError: z.boolean().optional(),
  }),
});
export const JsonRpcError = z.looseObject({
  jsonrpc: z.literal("2.0"),
  error: z.looseObject({ code: z.number(), message: z.string() }),
});

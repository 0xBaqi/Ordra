// Registry client. The gateway only depends on the RegistryClient interface,
// so tests can swap in a mock (or feed recorded HTTP bodies to this client).
import { CheckBadgeResult, JsonRpcError, ToolCallSuccess } from "./schema";

export type RegistryOutcome =
  | { kind: "ok"; data: CheckBadgeResult }
  | { kind: "unavailable"; detail: string; retryAfterSeconds?: number }
  | { kind: "malformed"; detail: string };

export interface RegistryClient {
  checkBadge(tokenAddress: string): Promise<RegistryOutcome>;
}

export interface McpRegistryOptions {
  baseUrl: string; // e.g. https://agent-registry-mcp.concordium.com
  network: string; // sent as `network`; check_badge may still resolve another network from the token
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class McpRegistryClient implements RegistryClient {
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(private readonly opts: McpRegistryOptions) {
    // Wrap so the Workers global fetch is never called with a foreign `this`.
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async checkBadge(tokenAddress: string): Promise<RegistryOutcome> {
    const body = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: "check_badge", arguments: { id: tokenAddress, network: this.opts.network } },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return { kind: "unavailable", detail: `request failed: ${errorMessage(err)}` };
    }

    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return {
        kind: "unavailable",
        detail: "rate limited (HTTP 429)",
        ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSeconds: ra } : {}),
      };
    }
    if (!res.ok) return { kind: "unavailable", detail: `HTTP ${res.status}` };

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { kind: "malformed", detail: "response is not JSON" };
    }
    return parseToolResult(json);
  }
}

/** Turn a JSON-RPC tools/call response into a RegistryOutcome. Never throws. */
export function parseToolResult(json: unknown): RegistryOutcome {
  const rpcError = JsonRpcError.safeParse(json);
  if (rpcError.success) {
    return { kind: "malformed", detail: `JSON-RPC error ${rpcError.data.error.code}: ${rpcError.data.error.message}` };
  }
  const env = ToolCallSuccess.safeParse(json);
  if (!env.success) return { kind: "malformed", detail: "unexpected JSON-RPC envelope" };
  const { content, isError } = env.data.result;
  const text = content[0]?.text;
  if (isError) return { kind: "malformed", detail: `tool error: ${truncate(text ?? "")}` };
  if (typeof text !== "string") return { kind: "malformed", detail: "tool result has no text content" };

  let inner: unknown;
  try {
    inner = JSON.parse(text);
  } catch {
    return { kind: "malformed", detail: "tool result text is not JSON" };
  }
  const parsed = CheckBadgeResult.safeParse(inner);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return { kind: "malformed", detail: `check_badge result failed schema at: ${where}` };
  }
  return { kind: "ok", data: parsed.data };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

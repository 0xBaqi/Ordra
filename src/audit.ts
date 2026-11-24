// Audit log: one structured JSON record per decision.
import type { CheckBadgeResult } from "./schema";
import type { ReasonCode } from "./policy";

export interface AuditRecord {
  id: string;
  timestamp: string; // ISO 8601, when the decision was made
  token_address: string | null;
  decision: "allow" | "deny";
  reason: ReasonCode | null;
  retryable: boolean;
  detail?: string;
  policy_version: string;
  trust: { network: string; registry_contract: string };
  request: { method: string; path: string };
  registry: {
    source: "live" | "cache" | "none"; // none = rejected before calling the registry
    attempts: number; // live calls made for this decision (0 when cached)
    fetched_at: string | null; // when the registry data was obtained
    outcome: "ok" | "unavailable" | "malformed" | null;
    outcome_detail?: string;
    data: CheckBadgeResult | null; // the full parsed check_badge result, incl. every issue
  };
}

export interface AuditStore {
  write(record: AuditRecord): Promise<void>;
  recent(limit: number): Promise<AuditRecord[]>;
}

/** Fallback for tests and for running without a KV binding. Lost on restart. */
export class MemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = [];
  constructor(private readonly max = 500) {}

  async write(record: AuditRecord): Promise<void> {
    this.records.unshift(record);
    if (this.records.length > this.max) this.records.length = this.max;
  }

  async recent(limit: number): Promise<AuditRecord[]> {
    return this.records.slice(0, limit);
  }
}

/** The subset of the KVNamespace API we use, so tests can pass a fake. */
export interface KvLike {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options: { prefix: string; limit: number }): Promise<{ keys: { name: string }[] }>;
}

const MAX_TS = 9_999_999_999_999; // ms; keys sort newest-first

export class KvAuditStore implements AuditStore {
  constructor(
    private readonly kv: KvLike,
    private readonly retentionSeconds?: number,
  ) {}

  static keyFor(record: AuditRecord): string {
    const inverted = (MAX_TS - Date.parse(record.timestamp)).toString().padStart(13, "0");
    return `audit:${inverted}:${record.id}`;
  }

  async write(record: AuditRecord): Promise<void> {
    await this.kv.put(
      KvAuditStore.keyFor(record),
      JSON.stringify(record),
      this.retentionSeconds ? { expirationTtl: this.retentionSeconds } : undefined,
    );
  }

  async recent(limit: number): Promise<AuditRecord[]> {
    const { keys } = await this.kv.list({ prefix: "audit:", limit });
    const values = await Promise.all(keys.map((k) => this.kv.get(k.name)));
    return values.flatMap((v) => {
      if (v === null) return [];
      try {
        return [JSON.parse(v) as AuditRecord];
      } catch {
        return [];
      }
    });
  }
}

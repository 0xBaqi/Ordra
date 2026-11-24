import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Offline check that every hosted agent card still has the exact bytes the registry
// hashed (and that we pinned on-chain). One changed byte makes check_badge deny with
// hash_mismatch, so this test is the gate before any card change is merged.
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("cards/manifest.json", root), "utf8")) as {
  cards: Array<{ file: string; sha256: string }>;
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("hosted agent cards", () => {
  it("every manifest entry matches the served bytes", () => {
    for (const c of manifest.cards) {
      expect(c.sha256, c.file).toMatch(/^[0-9a-f]{64}$/);
      const path = new URL(`public/${c.file}`, root);
      expect(existsSync(path), `${c.file} missing`).toBe(true);
      expect(sha256(readFileSync(path)), c.file).toBe(c.sha256);
    }
  });

  it("every card file has a manifest entry (no unpinned cards)", () => {
    const dir = new URL("public/agents/", root);
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".json"))
      .map((f) => `agents/${f.replace(/\\/g, "/")}`);
    expect(files.sort()).toEqual(manifest.cards.map((c) => c.file).sort());
  });
});

import { describe, expect, it } from "vitest";
import { get, makeDeps, replayFetch, tokenOf } from "./helpers";

describe("registry result cache", () => {
  it("serves repeat requests from cache within the TTL", async () => {
    const r = replayFetch("valid");
    const { deps, clock } = makeDeps({ fetch: r.fetch });
    await get(deps, "/protected", tokenOf("valid"));
    clock.t += 59_000;
    const { body } = await get(deps, "/protected", tokenOf("valid"));
    expect(body.decision).toBe("allow");
    expect(r.calls).toHaveLength(1);
    clock.t += 2_000;
    await get(deps, "/protected", tokenOf("valid"));
    expect(r.calls).toHaveLength(2);
  });

  it("caches failures for at most 5 seconds", async () => {
    const r = replayFetch(() => new Response("down", { status: 502 }));
    const { deps, clock } = makeDeps({ fetch: r.fetch });
    await get(deps, "/protected", tokenOf("valid"));
    clock.t += 4_000;
    await get(deps, "/protected", tokenOf("valid"));
    expect(r.calls).toHaveLength(1);
    clock.t += 1_500;
    await get(deps, "/protected", tokenOf("valid"));
    expect(r.calls).toHaveLength(2);
  });

  it("caches card_unreachable for at most 5 seconds", async () => {
    const r = replayFetch("card_host_down");
    const { deps, clock } = makeDeps({ fetch: r.fetch });
    await get(deps, "/protected", tokenOf("card_host_down"));
    expect(r.calls).toHaveLength(2); // initial + one retry
    clock.t += 5_001;
    await get(deps, "/protected", tokenOf("card_host_down"));
    expect(r.calls).toHaveLength(4);
  });
});

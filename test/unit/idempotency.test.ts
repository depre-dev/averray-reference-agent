import { describe, expect, it } from "vitest";
import { idempotencyKey, sha256Text } from "../../packages/mcp-common/src/idempotency.js";

describe("idempotency keys", () => {
  it("are stable and order-sensitive", () => {
    expect(idempotencyKey(["averray", "job-1", "claim"])).toBe(idempotencyKey(["averray", "job-1", "claim"]));
    expect(idempotencyKey(["averray", "job-1", "claim"])).not.toBe(idempotencyKey(["averray", "claim", "job-1"]));
  });

  it("hashes text deterministically", () => {
    expect(sha256Text("averray")).toHaveLength(64);
  });
});


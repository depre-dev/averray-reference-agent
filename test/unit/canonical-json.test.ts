import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/mcp-common/src/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });
});


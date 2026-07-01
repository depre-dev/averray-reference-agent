import { describe, expect, it } from "vitest";

import { classifyIngestBindError } from "../../packages/trace-mcp/src/ingest-errors.js";

describe("classifyIngestBindError", () => {
  it("treats EADDRINUSE as benign — warn and keep serving stdio", () => {
    const disposition = classifyIngestBindError(Object.assign(new Error("address in use"), { code: "EADDRINUSE" }));
    expect(disposition.retryable).toBe(true);
    expect(disposition.logKey).toBe("trace_http_ingest_port_unavailable_stdio_only");
  });

  it("treats other bind errors as genuine faults with the generic key", () => {
    const denied = classifyIngestBindError(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(denied.retryable).toBe(false);
    expect(denied.logKey).toBe("trace_http_ingest_error");
  });

  it("handles a codeless error and undefined without throwing", () => {
    expect(classifyIngestBindError(new Error("boom")).retryable).toBe(false);
    expect(classifyIngestBindError(undefined).retryable).toBe(false);
  });
});

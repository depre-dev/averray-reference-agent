/**
 * Classify an http.Server `error` from the trace HTTP-ingest listener.
 *
 * `EADDRINUSE` is expected and benign: trace-mcp also runs as a stdio MCP
 * server, and under Hermes v0.17 the s6 supervisor spawns the MCP set for more
 * than one service (the `main-hermes` gateway AND the `dashboard`), so a second
 * trace-mcp instance can't bind the shared ingest port. That must degrade to
 * stdio-only — an unhandled `error` event would otherwise crash the process,
 * and Hermes then reports the whole MCP server as "Connection closed" (which is
 * exactly what happened on the first v0.17 boot). Any other bind error is a
 * genuine fault worth surfacing at error level.
 */
export interface IngestBindErrorDisposition {
  /** True for the benign shared-port case — warn and keep serving stdio. */
  retryable: boolean;
  /** Structured log key. */
  logKey: string;
}

export function classifyIngestBindError(
  error: (Error & { code?: string }) | undefined
): IngestBindErrorDisposition {
  if (error?.code === "EADDRINUSE") {
    return { retryable: true, logKey: "trace_http_ingest_port_unavailable_stdio_only" };
  }
  return { retryable: false, logKey: "trace_http_ingest_error" };
}

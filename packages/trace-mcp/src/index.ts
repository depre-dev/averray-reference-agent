import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, logger, optionalEnv, query, runStdioServer } from "@avg/mcp-common";

const server = new McpServer({
  name: "trace-mcp",
  version: "0.1.0"
});

server.tool("trace_capture_step", "Capture an explicit interesting Hermes/Averray trace step.", {
  hermesRunId: z.string().optional(),
  runId: z.string().optional(),
  toolName: z.string().default("manual_trace_step"),
  input: z.unknown().default({}),
  output: z.unknown().default({})
}, async ({ hermesRunId, runId, toolName, input, output }) => {
  const resolvedRunId = runId ?? (await ensureRun(hermesRunId, `trace:${toolName}`));
  const rows = await query(
    `insert into tool_calls(run_id, idx, mcp_server, tool_name, input, output, finished_at)
     values (
       $1,
       coalesce((select max(idx) + 1 from tool_calls where run_id = $1), 0),
       'trace-mcp',
       $2,
       $3::jsonb,
       $4::jsonb,
       now()
     )
     returning id, idx`,
    [resolvedRunId, toolName, JSON.stringify(input), JSON.stringify(output)]
  );
  return jsonContent({ runId: resolvedRunId, step: rows[0] });
});

server.tool("trace_get_run", "Return a recorded run and its tool-call trace.", {
  runId: z.string().min(1)
}, async ({ runId }) => {
  return jsonContent(await loadRun(runId));
});

server.tool("trace_export_run", "Export a run trace for replay or human inspection.", {
  runId: z.string().min(1)
}, async ({ runId }) => {
  const run = await loadRun(runId);
  return jsonContent({
    exportedAt: new Date().toISOString(),
    schema: "averray-reference-agent.trace.v1",
    run
  });
});

startHttpIngest();
await runStdioServer(server);

function startHttpIngest() {
  const port = Number(optionalEnv("TRACE_HTTP_PORT", "8789"));
  http
    .createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/hermes-event") {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = await readBody(req);
        const event = JSON.parse(body);
        const hermesRunId = event?.payload?.run_id ?? event?.payload?.runId ?? event?.run_id;
        const runId = await ensureRun(hermesRunId, event?.kind ?? "hermes-event");
        await query(
          `insert into tool_calls(run_id, idx, mcp_server, tool_name, input, output, finished_at)
           values (
             $1,
             coalesce((select max(idx) + 1 from tool_calls where run_id = $1), 0),
             'hermes-plugin',
             $2,
             $3::jsonb,
             '{}'::jsonb,
             now()
           )`,
          [runId, event?.kind ?? "hermes-event", JSON.stringify(event)]
        );
        res.writeHead(204).end();
      } catch (error) {
        logger.warn({ err: error }, "trace_http_ingest_failed");
        res.writeHead(500).end();
      }
    })
    .listen(port, "0.0.0.0", () => logger.info({ port }, "trace_http_ingest_listening"));
}

async function ensureRun(hermesRunId: string | undefined, task: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into runs(hermes_run_id, task, mode, state)
     values ($1, $2, 'mixed', 'running')
     on conflict(hermes_run_id) do update set state = runs.state
     returning id`,
    [hermesRunId ?? `manual-${Date.now()}`, task]
  );
  return rows[0].id;
}

async function loadRun(runId: string) {
  const runs = await query("select * from runs where id = $1", [runId]);
  const calls = await query("select * from tool_calls where run_id = $1 order by idx asc, started_at asc", [runId]);
  const receipts = await query("select * from receipts where run_id = $1", [runId]);
  return { run: runs[0], toolCalls: calls, receipts };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}


import { fileURLToPath } from "node:url";

import { redact } from "./codex-branch-worker.js";
import {
  parseClaudeWorkerConfig,
  parseClaudeWorkerTask,
  runClaudeBranchWorker,
} from "./claude-branch-worker.js";
import { DOCS_AGENT_ID } from "./specialist-agents.js";

export async function runDocsBranchWorker(): Promise<void> {
  await runClaudeBranchWorker(
    { ...parseClaudeWorkerTask(), agent: DOCS_AGENT_ID },
    parseClaudeWorkerConfig()
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runDocsBranchWorker()
    .catch((error) => {
      console.error(redact(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}

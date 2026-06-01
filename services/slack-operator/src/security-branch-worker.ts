import { fileURLToPath } from "node:url";

import { redact } from "./codex-branch-worker.js";
import {
  parseClaudeWorkerConfig,
  parseClaudeWorkerTask,
  runClaudeBranchWorker,
} from "./claude-branch-worker.js";
import { SECURITY_AGENT_ID } from "./specialist-agents.js";

export async function runSecurityBranchWorker(): Promise<void> {
  await runClaudeBranchWorker(
    { ...parseClaudeWorkerTask(), agent: SECURITY_AGENT_ID },
    parseClaudeWorkerConfig()
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runSecurityBranchWorker()
    .catch((error) => {
      console.error(redact(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}

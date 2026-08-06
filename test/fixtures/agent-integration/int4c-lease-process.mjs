import { setTimeout as delay } from "node:timers/promises";

import {
  acquireDispatchLease,
  renewDispatchLease,
} from "../../../packages/averray-mcp/dist/dispatch-claim.js";
import { closePool } from "../../../packages/mcp-common/dist/index.js";

const holder = process.argv[2];
const mode = process.argv[3];
const disableRenewal = process.env.INT4C_MUTATION === "disable-renewal";

if (!holder || (mode !== "holder" && mode !== "contender")) {
  throw new Error("usage: int4c-lease-process.mjs <holder> <holder|contender>");
}

let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
});

try {
  while (!stopped) {
    const acquired = await acquireDispatchLease({ holder, ttlSeconds: 1 });
    process.stdout.write(`INT4C_LEASE_ATTEMPT holder=${holder} acquired=${acquired}\n`);
    if (!acquired) {
      await delay(100);
      continue;
    }
    while (!stopped) {
      await delay(200);
      if (stopped) break;
      if (disableRenewal && mode === "holder") {
        process.stdout.write("INT4C_MUTATION_APPLIED=disable-renewal\n");
        continue;
      }
      const renewed = await renewDispatchLease({ holder, ttlSeconds: 1 });
      process.stdout.write(`INT4C_LEASE_RENEW holder=${holder} renewed=${renewed}\n`);
      if (!renewed) break;
    }
  }
} finally {
  await closePool();
}

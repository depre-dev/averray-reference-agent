import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  acquireDispatchLease,
  renewDispatchLease,
} from "../../../packages/averray-mcp/dist/dispatch-claim.js";
import { closePool } from "../../../packages/mcp-common/dist/index.js";

const holder = process.argv[2];
const mode = process.argv[3];
const ttlSeconds = Number(process.argv[4] ?? "1");

if (!holder || !["renew", "contend"].includes(mode)) {
  throw new Error("usage: int4c-d0-lease-process.mjs <holder> <renew|contend> <ttl-seconds>");
}

let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
});

try {
  while (!stopped) {
    const acquired = await acquireDispatchLease({ holder, ttlSeconds });
    process.stdout.write(`INT4C_D0_LEASE_ATTEMPT holder=${holder} acquired=${acquired}\n`);
    if (acquired) {
      while (!stopped) {
        await delay(200);
        if (stopped) break;
        const renewed = await renewDispatchLease({ holder, ttlSeconds });
        process.stdout.write(`INT4C_D0_LEASE_RENEW holder=${holder} renewed=${renewed}\n`);
        if (!renewed) break;
      }
    } else {
      await delay(200);
    }
  }
} finally {
  await closePool();
}

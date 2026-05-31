import { mintBrowserSessionWithPlaywright } from "./browser-session.js";
import { createTestWalletSignerHttpServer } from "./server.js";
import { loadTestWalletSignerConfig, redactSensitive, TestWalletSessionBroker } from "./sessions.js";

const config = loadTestWalletSignerConfig();

if (!config.enabled) {
  console.info("[test-wallet-signer] disabled; set TEST_WALLET_SIGNER_ENABLED=1 to serve sessions");
  process.exit(0);
}

const broker = new TestWalletSessionBroker(config, {
  browserMinter: mintBrowserSessionWithPlaywright
});
const server = createTestWalletSignerHttpServer(broker, config);

server.listen(config.port, config.host, () => {
  const roles = Object.keys(config.wallets).sort().join(",");
  console.info(`[test-wallet-signer] listening on ${config.host}:${config.port}; environment=${config.environment}; roles=${roles}`);
});

server.on("error", (error) => {
  console.error(`[test-wallet-signer] ${redactSensitive(error.message)}`);
  process.exitCode = 1;
});

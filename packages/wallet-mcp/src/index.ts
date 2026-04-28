import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { assertNoKillSwitch, jsonContent, optionalEnv, requiredEnv, runStdioServer, siweLogin } from "@avg/mcp-common";

const server = new McpServer({
  name: "wallet-mcp",
  version: "0.1.0"
});

server.tool("wallet_status", "Return wallet status and configured signing modes.", {}, async () => {
  const configuredKey = optionalEnv("AGENT_WALLET_PRIVATE_KEY");
  const account = configuredKey ? tryAccountFromPrivateKey(configuredKey) : null;
  return jsonContent({
    address: account?.address ?? null,
    configured: Boolean(account),
    extensionMode: Boolean(optionalEnv("BROWSER_CDP_URL")),
    siweFallbackMode: Boolean(account),
    network: optionalEnv("WALLET_NETWORK", "testnet"),
    message: account
      ? "Wallet key is configured for SIWE fallback."
      : "No usable AGENT_WALLET_PRIVATE_KEY is configured. Read-only tools still work; claiming/submitting requires a testnet wallet key."
  });
});

server.tool("wallet_export_address", "Return the test wallet public address.", {}, async () => {
  return jsonContent({ address: accountFromEnv().address });
});

server.tool("wallet_sign_siwe", "Sign into Averray with the test wallet via SIWE fallback.", {
  baseUrl: z.string().url().default(optionalEnv("AVERRAY_API_BASE_URL", "https://api.averray.com"))
}, async ({ baseUrl }) => {
  await assertNoKillSwitch("wallet_sign_siwe");
  return jsonContent(await siweLogin(baseUrl));
});

server.tool("wallet_open_extension_popup", "Open/approve a wallet extension popup when Hermes browser mode needs it.", {
  reason: z.string().min(1),
  approvalId: z.string().optional()
}, async ({ reason, approvalId }) => {
  await assertNoKillSwitch("wallet_open_extension_popup");
  const cdpUrl = optionalEnv("BROWSER_CDP_URL");
  if (!cdpUrl) {
    return jsonContent({
      status: "manual_required",
      reason,
      approvalId,
      message:
        "BROWSER_CDP_URL is not configured. Use Hermes browser UI to approve the wallet popup, or use wallet_sign_siwe fallback."
    });
  }
  return jsonContent({
    status: "cdp_not_implemented",
    reason,
    approvalId,
    cdpUrl,
    message:
      "CDP popup driving is intentionally gated for v1. The tool detects configured browser access but requires explicit implementation after Hermes browser target shape is verified."
  });
});

await runStdioServer(server);

function accountFromEnv() {
  return privateKeyToAccount(requiredEnv("AGENT_WALLET_PRIVATE_KEY") as `0x${string}`);
}

function tryAccountFromPrivateKey(privateKey: string) {
  try {
    return privateKeyToAccount(privateKey as `0x${string}`);
  } catch {
    return null;
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  canonicalJson,
  jsonContent,
  query,
  requiredEnv,
  runStdioServer,
  sha256Text
} from "@avg/mcp-common";

const server = new McpServer({
  name: "receipt-mcp",
  version: "0.1.0"
});

server.tool("receipt_build", "Build an unsigned Averray reference-agent receipt payload.", {
  runId: z.string().min(1),
  marketplaceId: z.string().default("averray"),
  externalTaskId: z.string().min(1),
  skillId: z.string().min(1),
  skillVersion: z.string().default("v1"),
  model: z.object({
    provider: z.string(),
    name: z.string(),
    promptHash: z.string().optional()
  }),
  evidence: z.array(z.object({
    kind: z.string(),
    hash: z.string(),
    sourceUrl: z.string().optional()
  })).default([]),
  output: z.unknown(),
  budget: z.object({
    tokensIn: z.number().int().nonnegative().default(0),
    tokensOut: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0)
  })
}, async (input) => {
  const account = privateKeyToAccount(requiredEnv("AGENT_WALLET_PRIVATE_KEY") as `0x${string}`);
  const outputHash = sha256Text(canonicalJson(input.output));
  const payload = {
    runId: input.runId,
    identityWallet: account.address,
    marketplaceId: input.marketplaceId,
    externalTaskId: input.externalTaskId,
    skillId: input.skillId,
    skillVersion: input.skillVersion,
    model: input.model,
    evidence: input.evidence,
    output: { hash: outputHash, value: input.output },
    budget: input.budget,
    timestamps: {
      plannedAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
      validatedAt: new Date().toISOString()
    }
  };
  return jsonContent({ payload, payloadHash: sha256Text(canonicalJson(payload)) });
});

server.tool("receipt_sign", "Sign a receipt payload with the reference-agent test wallet.", {
  payload: z.unknown()
}, async ({ payload }) => {
  const account = privateKeyToAccount(requiredEnv("AGENT_WALLET_PRIVATE_KEY") as `0x${string}`);
  const message = canonicalJson(payload);
  const signature = await account.signMessage({ message });
  return jsonContent({
    payload,
    signature: {
      algo: "secp256k1",
      value: signature
    },
    signedAt: new Date().toISOString()
  });
});

server.tool("receipt_persist", "Persist a signed receipt in Postgres.", {
  runId: z.string().min(1),
  payload: z.unknown(),
  signature: z.string().min(1)
}, async ({ runId, payload, signature }) => {
  const rows = await query(
    `insert into receipts(run_id, payload, signature)
     values ($1, $2::jsonb, $3)
     on conflict(run_id) do update
     set payload = excluded.payload, signature = excluded.signature, signed_at = now()
     returning id, signed_at`,
    [runId, JSON.stringify(payload), signature]
  );
  return jsonContent({ persisted: true, receipt: rows[0] });
});

await runStdioServer(server);


import { privateKeyToAccount } from "viem/accounts";
import { optionalEnv, requiredEnv } from "./config.js";

export interface AuthSession {
  wallet: string;
  token: string;
  expiresAt?: string;
}

export async function siweLogin(baseUrl = optionalEnv("AVERRAY_API_BASE_URL")): Promise<AuthSession> {
  const privateKey = requiredEnv("AGENT_WALLET_PRIVATE_KEY") as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const nonceResponse = await fetch(`${trimTrailingSlash(baseUrl)}/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address })
  });
  const noncePayload = await nonceResponse.json().catch(() => ({}));
  if (!nonceResponse.ok) {
    throw new Error(`/auth/nonce failed ${nonceResponse.status}: ${noncePayload?.message ?? "unknown_error"}`);
  }
  const signature = await account.signMessage({ message: noncePayload.message });
  const verifyResponse = await fetch(`${trimTrailingSlash(baseUrl)}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: noncePayload.message, signature })
  });
  const verifyPayload = await verifyResponse.json().catch(() => ({}));
  if (!verifyResponse.ok) {
    throw new Error(`/auth/verify failed ${verifyResponse.status}: ${verifyPayload?.message ?? "unknown_error"}`);
  }
  return {
    wallet: verifyPayload.wallet ?? account.address,
    token: verifyPayload.token,
    expiresAt: verifyPayload.expiresAt
  };
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

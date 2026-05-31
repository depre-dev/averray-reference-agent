import { privateKeyToAccount } from "viem/accounts";
import { optionalEnv, requiredEnv } from "./config.js";

export interface AuthSession {
  wallet: string;
  token: string;
  expiresAt?: string;
}

export interface SiweSigner {
  address: string;
  signMessage(args: { message: string }): Promise<string>;
}

export interface SiwePostJsonResult {
  ok: boolean;
  status: number;
  payload: any;
}

export type SiwePostJson = (path: string, body: unknown) => Promise<SiwePostJsonResult>;

export async function siweLogin(baseUrl = optionalEnv("AVERRAY_API_BASE_URL")): Promise<AuthSession> {
  const privateKey = requiredEnv("AGENT_WALLET_PRIVATE_KEY") as `0x${string}`;
  return siweLoginWithPrivateKey(privateKey, { baseUrl });
}

export async function siweLoginWithPrivateKey(
  privateKey: `0x${string}`,
  options: { baseUrl?: string; postJson?: SiwePostJson } = {}
): Promise<AuthSession> {
  return siweLoginWithSigner(privateKeyToAccount(privateKey), options);
}

export async function siweLoginWithSigner(
  signer: SiweSigner,
  options: { baseUrl?: string; postJson?: SiwePostJson } = {}
): Promise<AuthSession> {
  const baseUrl = options.baseUrl ?? optionalEnv("AVERRAY_API_BASE_URL");
  const postJson = options.postJson ?? createFetchPostJson(baseUrl);
  const nonceResponse = await postJson("/auth/nonce", { wallet: signer.address });
  if (!nonceResponse.ok) {
    throw new Error(`/auth/nonce failed ${nonceResponse.status}: ${nonceResponse.payload?.message ?? "unknown_error"}`);
  }
  const signature = await signer.signMessage({ message: nonceResponse.payload.message });
  const verifyResponse = await postJson("/auth/verify", {
    message: nonceResponse.payload.message,
    signature
  });
  if (!verifyResponse.ok) {
    throw new Error(`/auth/verify failed ${verifyResponse.status}: ${verifyResponse.payload?.message ?? "unknown_error"}`);
  }
  return {
    wallet: verifyResponse.payload.wallet ?? signer.address,
    token: verifyResponse.payload.token,
    expiresAt: verifyResponse.payload.expiresAt
  };
}

function createFetchPostJson(baseUrl: string): SiwePostJson {
  return async (path, body) => {
    const response = await fetch(`${trimTrailingSlash(baseUrl)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return {
      ok: response.ok,
      status: response.status,
      payload: await response.json().catch(() => ({}))
    };
  };
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

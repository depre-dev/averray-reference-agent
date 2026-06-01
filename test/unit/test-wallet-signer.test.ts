import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createTestWalletSignerHttpServer } from "../../services/test-wallet-signer/src/server.js";
import {
  loadTestWalletSignerConfig,
  redactSensitive,
  TestWalletSessionBroker,
  TestWalletSignerError,
  type ApiSessionMinter,
  type BrowserSessionMinter,
  type TestWalletRole,
  type TestWalletSignerConfig
} from "../../services/test-wallet-signer/src/sessions.js";

const KEYS = {
  agent: testPrivateKey(1),
  admin: testPrivateKey(2),
  verifier: testPrivateKey(3)
} as const;

describe("test-wallet signer sidecar", () => {
  it("mints API and browser sessions per testnet role", async () => {
    const config = configFromEnv();
    const apiCalls: string[] = [];
    const browserCalls: string[] = [];
    const broker = new TestWalletSessionBroker(config, {
      apiMinter: async (wallet) => {
        apiCalls.push(wallet.role);
        return {
          wallet: wallet.account.address,
          token: `jwt-${wallet.role}`,
          expiresAt: "2026-05-31T12:00:00.000Z"
        };
      },
      browserMinter: async (wallet) => {
        browserCalls.push(wallet.role);
        return {
          wallet: wallet.account.address,
          storageState: { cookies: [{ name: `refresh-${wallet.role}` }], origins: [] },
          expiresAt: "2026-05-31T12:00:00.000Z"
        };
      }
    });

    for (const role of ["agent", "admin", "verifier"] as const) {
      const api = await broker.getSession(role, "api");
      expect(api).toMatchObject({
        type: "api",
        role,
        roles: [role],
        token: `jwt-${role}`,
        environment: "testnet",
        readOnly: false
      });
      const browser = await broker.getSession(role, "browser");
      expect(browser).toMatchObject({
        type: "browser",
        role,
        roles: [role],
        storageState: { cookies: [{ name: `refresh-${role}` }], origins: [] },
        environment: "testnet",
        readOnly: false
      });
    }
    expect(apiCalls).toEqual(["agent", "admin", "verifier"]);
    expect(browserCalls).toEqual(["agent", "admin", "verifier"]);
  });

  it("caches sessions until refresh skew, then remints", async () => {
    let nowMs = Date.parse("2026-05-31T11:00:00.000Z");
    let count = 0;
    const broker = new TestWalletSessionBroker(configFromEnv({ TEST_WALLET_SIGNER_REFRESH_SKEW_SECONDS: "60" }), {
      now: () => new Date(nowMs),
      apiMinter: async (wallet) => ({
        wallet: wallet.account.address,
        token: `jwt-${++count}`,
        expiresAt: "2026-05-31T12:00:00.000Z"
      })
    });

    const first = await broker.getSession("agent", "api");
    const second = await broker.getSession("agent", "api");
    expect(first).toBe(second);
    expect(count).toBe(1);

    nowMs = Date.parse("2026-05-31T11:59:30.000Z");
    const third = await broker.getSession("agent", "api");
    expect(third).not.toBe(first);
    expect(third).toMatchObject({ token: "jwt-2" });
    expect(count).toBe(2);
  });

  it("mainnet profile only exposes a read-only agent session", async () => {
    const config = configFromEnv({
      TEST_WALLET_SIGNER_ENVIRONMENT: "mainnet",
      TEST_WALLET_ADMIN_PRIVATE_KEY: "",
      TEST_WALLET_VERIFIER_PRIVATE_KEY: ""
    });
    expect(Object.keys(config.wallets)).toEqual(["agent"]);

    const broker = new TestWalletSessionBroker(config, {
      apiMinter: async (wallet) => ({
        wallet: wallet.account.address,
        token: "jwt-agent",
        expiresAt: "2026-05-31T12:00:00.000Z"
      })
    });

    const agent = await broker.getSession("agent", "api");
    expect(agent).toMatchObject({ role: "agent", readOnly: true, environment: "mainnet" });
    await expect(broker.getSession("admin", "api")).rejects.toMatchObject({
      statusCode: 403,
      message: "mainnet signer profile only allows a read-only agent session"
    });
    await expect(broker.getSession("verifier", "browser")).rejects.toMatchObject({
      statusCode: 403
    });
  });

  it("does not require role keys while disabled", () => {
    const config = loadTestWalletSignerConfig({
      TEST_WALLET_SIGNER_ENABLED: "0",
      TEST_WALLET_SIGNER_ENVIRONMENT: "testnet"
    });

    expect(config.enabled).toBe(false);
    expect(config.wallets).toEqual({});
  });

  it("loads Cloudflare Access service token refs without treating them as wallet keys", () => {
    const config = loadTestWalletSignerConfig({
      TEST_WALLET_SIGNER_ENABLED: "0",
      TESTBED_CF_ACCESS_CLIENT_ID: "cf-client-id",
      TESTBED_CF_ACCESS_CLIENT_SECRET: "cf-client-secret"
    });

    expect(config.cfAccessClientId).toBe("cf-client-id");
    expect(config.cfAccessClientSecret).toBe("cf-client-secret");
    expect(config.wallets).toEqual({});
  });

  it("never reflects private keys or bearer tokens in error output", async () => {
    const secret = KEYS.agent;
    const server = createTestWalletSignerHttpServer({
      async getSession() {
        throw new TestWalletSignerError(`bad key ${secret} and Bearer secret-token`, 500);
      }
    }, { environment: "testnet" });
    await listen(server);
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/session/agent?type=api`);
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("secret-token");
      expect(text).toContain("[redacted-private-key]");
      expect(text).toContain("Bearer [redacted-token]");
      expect(redactSensitive(`jwt ${secret}`)).not.toContain(secret);
    } finally {
      await close(server);
    }
  });

  it("HTTP endpoint serves cached sessions without logging secrets", async () => {
    const apiMinter = vi.fn<ApiSessionMinter>(async (wallet) => ({
      wallet: wallet.account.address,
      token: "jwt-agent",
      expiresAt: "2026-05-31T12:00:00.000Z"
    }));
    const browserMinter = vi.fn<BrowserSessionMinter>(async (wallet) => ({
      wallet: wallet.account.address,
      storageState: { cookies: [{ name: "refresh" }], origins: [] },
      expiresAt: "2026-05-31T12:00:00.000Z"
    }));
    const config = configFromEnv();
    const broker = new TestWalletSessionBroker(config, { apiMinter, browserMinter });
    const server = createTestWalletSignerHttpServer(broker, config);
    await listen(server);
    try {
      const port = (server.address() as AddressInfo).port;
      const api = await getJson(`http://127.0.0.1:${port}/session/agent?type=api`);
      expect(api).toMatchObject({ type: "api", role: "agent", token: "jwt-agent" });
      const browser = await getJson(`http://127.0.0.1:${port}/session/admin?type=browser`);
      expect(browser).toMatchObject({ type: "browser", role: "admin", storageState: { cookies: [{ name: "refresh" }], origins: [] } });
      expect(apiMinter).toHaveBeenCalledTimes(1);
      expect(browserMinter).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });
});

function configFromEnv(overrides: Record<string, string> = {}): TestWalletSignerConfig {
  return loadTestWalletSignerConfig({
    TEST_WALLET_SIGNER_ENABLED: "1",
    TEST_WALLET_SIGNER_ENVIRONMENT: "testnet",
    AVERRAY_API_BASE_URL: "https://api.test.invalid",
    AVERRAY_APP_BASE_URL: "https://app.test.invalid",
    TEST_WALLET_AGENT_PRIVATE_KEY: KEYS.agent,
    TEST_WALLET_ADMIN_PRIVATE_KEY: KEYS.admin,
    TEST_WALLET_VERIFIER_PRIVATE_KEY: KEYS.verifier,
    ...overrides
  });
}

async function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}

function testPrivateKey(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

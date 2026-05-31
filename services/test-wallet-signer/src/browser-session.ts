import { chromium, type APIRequestContext } from "playwright-core";
import { siweLoginWithSigner, trimTrailingSlash, type SiwePostJson } from "@avg/mcp-common";

import type { BrowserMintResult, RoleWallet, TestWalletSignerConfig } from "./sessions.js";

export async function mintBrowserSessionWithPlaywright(
  wallet: RoleWallet,
  config: TestWalletSignerConfig
): Promise<BrowserMintResult> {
  const browser = await chromium.launch({
    headless: true,
    ...(config.browserExecutablePath ? { executablePath: config.browserExecutablePath } : {})
  });
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(config.appBaseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.close();

      const session = await siweLoginWithSigner(wallet.account, {
        baseUrl: config.apiBaseUrl,
        postJson: createPlaywrightPostJson(context.request, config.apiBaseUrl)
      });
      return {
        wallet: session.wallet,
        storageState: await context.storageState(),
        expiresAt: session.expiresAt
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function createPlaywrightPostJson(request: APIRequestContext, baseUrl: string): SiwePostJson {
  return async (path, body) => {
    const response = await request.post(`${trimTrailingSlash(baseUrl)}${path}`, {
      data: body,
      headers: { "content-type": "application/json" }
    });
    return {
      ok: response.ok(),
      status: response.status(),
      payload: await response.json().catch(() => ({}))
    };
  };
}

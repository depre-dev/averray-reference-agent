import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  parseSessionRole,
  parseSessionType,
  redactSensitive,
  TestWalletSignerError,
  type SessionType,
  type TestWalletRole,
  type TestWalletSession,
  type TestWalletSessionBroker,
  type TestWalletSignerConfig
} from "./sessions.js";

export interface SessionBrokerLike {
  getSession(role: TestWalletRole, type: SessionType): Promise<TestWalletSession>;
}

export function createTestWalletSignerHttpServer(
  broker: TestWalletSessionBroker | SessionBrokerLike,
  config: Pick<TestWalletSignerConfig, "environment">
): Server {
  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, broker, config);
    } catch (error) {
      writeError(response, error);
    }
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  broker: TestWalletSessionBroker | SessionBrokerLike,
  config: Pick<TestWalletSignerConfig, "environment">
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") {
    writeJson(response, 200, {
      status: "ok",
      service: "test-wallet-signer",
      environment: config.environment
    });
    return;
  }

  const match = /^\/session\/([^/]+)$/u.exec(url.pathname);
  if (!match) {
    writeJson(response, 404, { error: "not_found" });
    return;
  }

  const role = parseSessionRole(match[1]);
  if (!role) {
    writeJson(response, 404, { error: "unknown_role" });
    return;
  }
  const type = parseSessionType(url.searchParams.get("type"));
  if (!type) {
    writeJson(response, 400, { error: "invalid_session_type", allowed: ["api", "browser"] });
    return;
  }

  writeJson(response, 200, await broker.getSession(role, type));
}

function writeError(response: ServerResponse, error: unknown): void {
  const statusCode = error instanceof TestWalletSignerError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : String(error);
  writeJson(response, statusCode, {
    error: statusCode >= 500 ? "session_mint_failed" : "session_unavailable",
    message: redactSensitive(message)
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

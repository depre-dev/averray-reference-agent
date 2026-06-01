import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { siweLoginWithPrivateKey } from "@avg/mcp-common";

export const TEST_WALLET_ROLES = ["agent", "admin", "verifier"] as const;
export const SESSION_TYPES = ["api", "browser"] as const;

export type TestWalletRole = (typeof TEST_WALLET_ROLES)[number];
export type SessionType = (typeof SESSION_TYPES)[number];
export type SignerEnvironment = "testnet" | "mainnet";

export interface BrowserStorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

export interface RoleWallet {
  role: TestWalletRole;
  roles: string[];
  privateKey: `0x${string}`;
  account: PrivateKeyAccount;
}

export interface TestWalletSignerConfig {
  enabled: boolean;
  host: string;
  port: number;
  environment: SignerEnvironment;
  apiBaseUrl: string;
  appBaseUrl: string;
  authTokenTtlSeconds: number;
  refreshSkewSeconds: number;
  browserExecutablePath?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  wallets: Partial<Record<TestWalletRole, RoleWallet>>;
}

export interface ApiSessionPayload {
  type: "api";
  role: TestWalletRole;
  roles: string[];
  wallet: string;
  token: string;
  expiresAt: string;
  environment: SignerEnvironment;
  readOnly: boolean;
}

export interface BrowserSessionPayload {
  type: "browser";
  role: TestWalletRole;
  roles: string[];
  wallet: string;
  storageState: BrowserStorageState;
  expiresAt: string;
  environment: SignerEnvironment;
  readOnly: boolean;
}

export type TestWalletSession = ApiSessionPayload | BrowserSessionPayload;

export interface ApiMintResult {
  wallet: string;
  token: string;
  expiresAt?: string;
}

export interface BrowserMintResult {
  wallet: string;
  storageState: BrowserStorageState;
  expiresAt?: string;
}

export type ApiSessionMinter = (wallet: RoleWallet, config: TestWalletSignerConfig) => Promise<ApiMintResult>;
export type BrowserSessionMinter = (wallet: RoleWallet, config: TestWalletSignerConfig) => Promise<BrowserMintResult>;

export interface TestWalletSessionBrokerDeps {
  apiMinter?: ApiSessionMinter;
  browserMinter?: BrowserSessionMinter;
  now?: () => Date;
}

export class TestWalletSignerError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500
  ) {
    super(message);
    this.name = "TestWalletSignerError";
  }
}

export class TestWalletSessionBroker {
  private readonly cache = new Map<string, TestWalletSession>();
  private readonly apiMinter: ApiSessionMinter;
  private readonly browserMinter: BrowserSessionMinter;
  private readonly now: () => Date;

  constructor(
    private readonly config: TestWalletSignerConfig,
    deps: TestWalletSessionBrokerDeps = {}
  ) {
    this.apiMinter = deps.apiMinter ?? mintApiSessionWithSiwe;
    this.browserMinter = deps.browserMinter ?? missingBrowserMinter;
    this.now = deps.now ?? (() => new Date());
  }

  async getSession(role: TestWalletRole, type: SessionType): Promise<TestWalletSession> {
    const wallet = this.walletForRole(role);
    const cacheKey = `${role}:${type}`;
    const cached = this.cache.get(cacheKey);
    if (cached && !this.isNearExpiry(cached.expiresAt)) return cached;

    const minted = type === "api"
      ? await this.mintApiSession(wallet)
      : await this.mintBrowserSession(wallet);
    this.cache.set(cacheKey, minted);
    return minted;
  }

  private walletForRole(role: TestWalletRole): RoleWallet {
    const wallet = this.config.wallets[role];
    if (!wallet) {
      if (this.config.environment === "mainnet" && role !== "agent") {
        throw new TestWalletSignerError("mainnet signer profile only allows a read-only agent session", 403);
      }
      throw new TestWalletSignerError(`test wallet role is not configured: ${role}`, 503);
    }
    return wallet;
  }

  private async mintApiSession(wallet: RoleWallet): Promise<ApiSessionPayload> {
    const minted = await this.apiMinter(wallet, this.config);
    return {
      type: "api",
      role: wallet.role,
      roles: wallet.roles,
      wallet: minted.wallet,
      token: minted.token,
      expiresAt: this.normalizedExpiresAt(minted.expiresAt),
      environment: this.config.environment,
      readOnly: isReadOnlyEnvironment(this.config.environment)
    };
  }

  private async mintBrowserSession(wallet: RoleWallet): Promise<BrowserSessionPayload> {
    const minted = await this.browserMinter(wallet, this.config);
    return {
      type: "browser",
      role: wallet.role,
      roles: wallet.roles,
      wallet: minted.wallet,
      storageState: minted.storageState,
      expiresAt: this.normalizedExpiresAt(minted.expiresAt),
      environment: this.config.environment,
      readOnly: isReadOnlyEnvironment(this.config.environment)
    };
  }

  private normalizedExpiresAt(expiresAt?: string): string {
    const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return new Date(this.now().getTime() + this.config.authTokenTtlSeconds * 1000).toISOString();
  }

  private isNearExpiry(expiresAt: string): boolean {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) return true;
    return this.now().getTime() + this.config.refreshSkewSeconds * 1000 >= expiresMs;
  }
}

export async function mintApiSessionWithSiwe(
  wallet: RoleWallet,
  config: TestWalletSignerConfig
): Promise<ApiMintResult> {
  return siweLoginWithPrivateKey(wallet.privateKey, { baseUrl: config.apiBaseUrl });
}

export function loadTestWalletSignerConfig(env: NodeJS.ProcessEnv = process.env): TestWalletSignerConfig {
  const enabled = parseBoolean(env.TEST_WALLET_SIGNER_ENABLED, false);
  const environment = parseEnvironment(env.TEST_WALLET_SIGNER_ENVIRONMENT);
  const requiredRoles = environment === "mainnet" ? ["agent"] as const : TEST_WALLET_ROLES;
  const cfAccessClientId = firstNonEmpty(env.TESTBED_CF_ACCESS_CLIENT_ID, env.CF_ACCESS_CLIENT_ID, env.CLOUDFLARE_ACCESS_CLIENT_ID);
  const cfAccessClientSecret = firstNonEmpty(env.TESTBED_CF_ACCESS_CLIENT_SECRET, env.CF_ACCESS_CLIENT_SECRET, env.CLOUDFLARE_ACCESS_CLIENT_SECRET);
  const wallets: Partial<Record<TestWalletRole, RoleWallet>> = {};
  if (enabled) {
    for (const role of requiredRoles) {
      wallets[role] = parseRoleWallet(role, requiredKey(env, keyEnvName(role)));
    }
  }

  return {
    enabled,
    host: env.TEST_WALLET_SIGNER_HOST || "0.0.0.0",
    port: positiveInt(env.TEST_WALLET_SIGNER_PORT, 8791),
    environment,
    apiBaseUrl: env.AVERRAY_API_BASE_URL || "https://api.averray.com",
    appBaseUrl: env.AVERRAY_APP_BASE_URL || "https://app.averray.com",
    authTokenTtlSeconds: positiveInt(env.AUTH_TOKEN_TTL_SECONDS, 3600),
    refreshSkewSeconds: positiveInt(env.TEST_WALLET_SIGNER_REFRESH_SKEW_SECONDS, 60),
    ...(env.TEST_WALLET_SIGNER_BROWSER_EXECUTABLE_PATH
      ? { browserExecutablePath: env.TEST_WALLET_SIGNER_BROWSER_EXECUTABLE_PATH }
      : {}),
    ...(cfAccessClientId ? { cfAccessClientId } : {}),
    ...(cfAccessClientSecret ? { cfAccessClientSecret } : {}),
    wallets
  };
}

export function parseSessionRole(value: string | undefined): TestWalletRole | null {
  return TEST_WALLET_ROLES.includes(value as TestWalletRole) ? value as TestWalletRole : null;
}

export function parseSessionType(value: string | null): SessionType | null {
  const normalized = value || "api";
  return SESSION_TYPES.includes(normalized as SessionType) ? normalized as SessionType : null;
}

export function redactSensitive(value: string): string {
  return value
    .replace(/0x[a-fA-F0-9]{64}/gu, "[redacted-private-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gu, "Bearer [redacted-token]")
    .replace(/\beyJ[A-Za-z0-9._~+/-]+=*/gu, "[redacted-jwt]");
}

function parseRoleWallet(role: TestWalletRole, privateKey: string): RoleWallet {
  try {
    const typedKey = privateKey as `0x${string}`;
    return {
      role,
      roles: [role],
      privateKey: typedKey,
      account: privateKeyToAccount(typedKey)
    };
  } catch {
    throw new TestWalletSignerError(`${keyEnvName(role)} is not a valid private key`, 500);
  }
}

function keyEnvName(role: TestWalletRole): string {
  return `TEST_WALLET_${role.toUpperCase()}_PRIVATE_KEY`;
}

function requiredKey(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new TestWalletSignerError(`Missing required environment variable ${name}`, 500);
  return value;
}

function parseEnvironment(value: string | undefined): SignerEnvironment {
  if (!value || value === "testnet") return "testnet";
  if (value === "mainnet") return "mainnet";
  throw new TestWalletSignerError("TEST_WALLET_SIGNER_ENVIRONMENT must be testnet or mainnet", 500);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isReadOnlyEnvironment(environment: SignerEnvironment): boolean {
  return environment === "mainnet";
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

async function missingBrowserMinter(): Promise<BrowserMintResult> {
  throw new TestWalletSignerError("browser session minter is not configured", 500);
}

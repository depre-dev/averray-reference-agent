import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PilotProfileManifest } from "@avg/schemas";
import { parse } from "yaml";

export type VettedCapability = Readonly<{
  effectClass: "none" | "local";
  delegable: false;
}>;

export const VETTED_CAPABILITIES: ReadonlyMap<string, VettedCapability> =
  frozenReadonlyMap([
    ["fs.read_file", Object.freeze({ effectClass: "none", delegable: false })],
    ["fs.write_file", Object.freeze({ effectClass: "local", delegable: false })],
    ["fs.list_files", Object.freeze({ effectClass: "none", delegable: false })],
    ["shell.run", Object.freeze({ effectClass: "local", delegable: false })],
    ["git.status", Object.freeze({ effectClass: "none", delegable: false })],
    ["git.diff", Object.freeze({ effectClass: "none", delegable: false })],
    ["artifact.put", Object.freeze({ effectClass: "local", delegable: false })],
    ["artifact.get", Object.freeze({ effectClass: "none", delegable: false })],
  ]);

export type ProfileManifestErrorReason =
  | "missing_profiles_root"
  | "invalid_profile_id"
  | "profile_unreadable"
  | "profile_malformed"
  | "profile_hash_mismatch"
  | "invalid_strategy"
  | "unvetted_capability"
  | "delegable_capability";

export class ProfileManifestError extends Error {
  constructor(
    readonly reason: ProfileManifestErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "ProfileManifestError";
  }
}

export async function loadProfileManifest(
  profileId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PilotProfileManifest> {
  assertProfileId(profileId);
  const profilesRoot = environment.HARNESS_PROFILES_ROOT?.trim();
  if (!profilesRoot) {
    throw new ProfileManifestError(
      "missing_profiles_root",
      "HARNESS_PROFILES_ROOT is required",
    );
  }

  const profilePath = path.resolve(profilesRoot, profileId, "profile.yaml");
  assertProfilePathContained(profilesRoot, profilePath);
  let raw: Buffer;
  try {
    raw = await readFile(profilePath);
  } catch {
    throw new ProfileManifestError(
      "profile_unreadable",
      `Harness profile ${profileId} could not be read`,
    );
  }

  verifyProfileHash(raw, environment.HARNESS_PROFILE_SHA256);
  const document = parseProfile(raw, profileId);
  const strategies = parseStrategies(document, profileId);
  const capabilities = parseCapabilities(document, profileId);
  return { profileId, strategies, capabilities };
}

function assertProfileId(profileId: string): void {
  if (
    !profileId
    || profileId !== profileId.trim()
    || profileId.includes("/")
    || profileId.includes("\\")
    || profileId.includes("..")
  ) {
    throw new ProfileManifestError(
      "invalid_profile_id",
      "Harness profile id must be a single safe path segment",
    );
  }
}

function assertProfilePathContained(
  profilesRoot: string,
  profilePath: string,
): void {
  const resolvedRoot = path.resolve(profilesRoot);
  const relative = path.relative(resolvedRoot, profilePath);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new ProfileManifestError(
      "invalid_profile_id",
      "Harness profile path must remain under HARNESS_PROFILES_ROOT",
    );
  }
}

function verifyProfileHash(
  raw: Buffer,
  expectedInput: string | undefined,
): void {
  const expected = expectedInput?.trim();
  if (!expected) return;
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(expected);
  const actual = createHash("sha256").update(raw).digest("hex");
  if (!match || match[1]!.toLowerCase() !== actual) {
    throw new ProfileManifestError(
      "profile_hash_mismatch",
      "Harness profile SHA-256 does not match the configured pin",
    );
  }
}

function parseProfile(raw: Buffer, profileId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(raw.toString("utf8"));
  } catch {
    throw new ProfileManifestError(
      "profile_malformed",
      `Harness profile ${profileId} is malformed`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ProfileManifestError(
      "profile_malformed",
      `Harness profile ${profileId} must contain a YAML object`,
    );
  }
  return parsed;
}

function parseStrategies(
  document: Record<string, unknown>,
  profileId: string,
): string[] {
  const strategies = document.strategies;
  if (
    !Array.isArray(strategies)
    || strategies.length === 0
    || strategies.some((strategy) =>
      typeof strategy !== "string" || !strategy.trim())
  ) {
    throw new ProfileManifestError(
      "profile_malformed",
      `Harness profile ${profileId} has malformed strategies`,
    );
  }
  if (
    strategies.length !== 1
    || strategies[0] !== "direct_execution"
  ) {
    throw new ProfileManifestError(
      "invalid_strategy",
      `Harness profile ${profileId} must use direct_execution only`,
    );
  }
  return [...strategies] as string[];
}

function parseCapabilities(
  document: Record<string, unknown>,
  profileId: string,
): PilotProfileManifest["capabilities"] {
  const declared = document.capabilities;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new ProfileManifestError(
      "profile_malformed",
      `Harness profile ${profileId} has malformed capabilities`,
    );
  }

  const seen = new Set<string>();
  return declared.map((entry) => {
    const capability = parseCapabilityEntry(entry, profileId);
    if (seen.has(capability.id)) {
      throw new ProfileManifestError(
        "profile_malformed",
        `Harness profile ${profileId} repeats a capability id`,
      );
    }
    seen.add(capability.id);
    if (capability.delegable) {
      throw new ProfileManifestError(
        "delegable_capability",
        `Harness profile ${profileId} declares a delegable capability`,
      );
    }
    const vetted = VETTED_CAPABILITIES.get(capability.id);
    if (!vetted) {
      throw new ProfileManifestError(
        "unvetted_capability",
        `Harness profile ${profileId} declares an unvetted capability`,
      );
    }
    return { id: capability.id, ...vetted };
  });
}

function parseCapabilityEntry(
  entry: unknown,
  profileId: string,
): { id: string; delegable: boolean } {
  if (typeof entry === "string" && entry.trim()) {
    return { id: entry, delegable: false };
  }
  if (
    isRecord(entry)
    && typeof entry.id === "string"
    && entry.id.trim()
    && (entry.delegable === undefined || typeof entry.delegable === "boolean")
  ) {
    return { id: entry.id, delegable: entry.delegable === true };
  }
  throw new ProfileManifestError(
    "profile_malformed",
    `Harness profile ${profileId} has a malformed capability declaration`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frozenReadonlyMap(
  entries: ReadonlyArray<readonly [string, VettedCapability]>,
): ReadonlyMap<string, VettedCapability> {
  const map = new Map(entries);
  const rejectMutation = (): never => {
    throw new TypeError("Vetted capability registry is immutable");
  };
  Object.defineProperties(map, {
    set: { value: rejectMutation },
    delete: { value: rejectMutation },
    clear: { value: rejectMutation },
  });
  return Object.freeze(map);
}

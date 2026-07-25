import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadProfileManifest,
  ProfileManifestError,
  VETTED_CAPABILITIES,
} from "../../services/harness-dispatcher/src/profile-manifest.js";

const PILOT_CAPABILITIES = [
  "fs.read_file",
  "fs.write_file",
  "fs.list_files",
  "shell.run",
  "git.status",
  "git.diff",
  "artifact.put",
  "artifact.get",
];

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("pinned Harness profile manifests", () => {
  it("loads the real profile strategies and vetted capability metadata", async () => {
    const fixture = await profileFixture(validProfile());

    const manifest = await loadProfileManifest("pilot", fixture.environment);

    expect(manifest).toEqual({
      profileId: "pilot",
      strategies: ["direct_execution"],
      capabilities: [
        { id: "fs.read_file", effectClass: "none", delegable: false },
        { id: "fs.write_file", effectClass: "local", delegable: false },
        { id: "fs.list_files", effectClass: "none", delegable: false },
        { id: "shell.run", effectClass: "local", delegable: false },
        { id: "git.status", effectClass: "none", delegable: false },
        { id: "git.diff", effectClass: "none", delegable: false },
        { id: "artifact.put", effectClass: "local", delegable: false },
        { id: "artifact.get", effectClass: "none", delegable: false },
      ],
    });
    expect(Object.isFrozen(VETTED_CAPABILITIES)).toBe(true);
    expect(() => {
      (VETTED_CAPABILITIES as Map<string, unknown>).set(
        "network.fetch",
        {},
      );
    }).toThrow("Vetted capability registry is immutable");
  });

  it("fails closed on an unvetted capability id", async () => {
    const fixture = await profileFixture(
      validProfile(["fs.read_file", "network.fetch"]),
    );

    await expectProfileError(
      loadProfileManifest("pilot", fixture.environment),
      "unvetted_capability",
    );
  });

  it("fails closed on a capability marked delegable", async () => {
    const fixture = await profileFixture([
      "name: pilot",
      "capabilities:",
      "  - {id: fs.read_file, delegable: true}",
      "strategies: [direct_execution]",
      "",
    ].join("\n"));

    await expectProfileError(
      loadProfileManifest("pilot", fixture.environment),
      "delegable_capability",
    );
  });

  it("fails closed on plan_execute or any non-direct strategy set", async () => {
    const fixture = await profileFixture(
      validProfile(PILOT_CAPABILITIES, [
        "direct_execution",
        "plan_execute",
      ]),
    );

    await expectProfileError(
      loadProfileManifest("pilot", fixture.environment),
      "invalid_strategy",
    );
  });

  it.each(["../pilot", "nested/pilot", "pilot..backup"])(
    "fails closed on traversal-shaped profile id %s",
    async (profileId) => {
      await expectProfileError(
        loadProfileManifest(profileId, {
          HARNESS_PROFILES_ROOT: "/profiles",
        }),
        "invalid_profile_id",
      );
    },
  );

  it("fails closed when HARNESS_PROFILES_ROOT is missing", async () => {
    await expectProfileError(
      loadProfileManifest("pilot", {}),
      "missing_profiles_root",
    );
  });

  it("distinguishes an unreadable profile from malformed content", async () => {
    const root = await temporaryRoot();
    await expectProfileError(
      loadProfileManifest("missing", {
        HARNESS_PROFILES_ROOT: root,
      }),
      "profile_unreadable",
    );
  });

  it("fails closed on malformed YAML", async () => {
    const fixture = await profileFixture("capabilities: [");

    await expectProfileError(
      loadProfileManifest("pilot", fixture.environment),
      "profile_malformed",
    );
  });

  it("fails closed when the raw profile bytes do not match the SHA-256 pin", async () => {
    const fixture = await profileFixture(validProfile());

    await expectProfileError(
      loadProfileManifest("pilot", {
        ...fixture.environment,
        HARNESS_PROFILE_SHA256: "0".repeat(64),
      }),
      "profile_hash_mismatch",
    );
  });

  it("accepts a matching raw-byte SHA-256 pin", async () => {
    const yaml = validProfile();
    const fixture = await profileFixture(yaml);
    const hash = createHash("sha256").update(yaml, "utf8").digest("hex");

    await expect(loadProfileManifest("pilot", {
      ...fixture.environment,
      HARNESS_PROFILE_SHA256: `sha256:${hash}`,
    })).resolves.toMatchObject({ profileId: "pilot" });
  });
});

function validProfile(
  capabilities = PILOT_CAPABILITIES,
  strategies = ["direct_execution"],
): string {
  return [
    "name: pilot",
    "capabilities:",
    ...capabilities.map((capability) => `  - ${capability}`),
    `strategies: [${strategies.join(", ")}]`,
    "",
  ].join("\n");
}

async function profileFixture(
  yaml: string,
): Promise<{
  environment: Readonly<Record<string, string | undefined>>;
}> {
  const root = await temporaryRoot();
  const directory = path.join(root, "pilot");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "profile.yaml"), yaml, "utf8");
  return { environment: { HARNESS_PROFILES_ROOT: root } };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-profile-test-"));
  temporaryRoots.push(root);
  return root;
}

async function expectProfileError(
  promise: Promise<unknown>,
  reason: ProfileManifestError["reason"],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileManifestError);
    expect((error as ProfileManifestError).reason).toBe(reason);
    return;
  }
  throw new Error(`Expected profile manifest failure: ${reason}`);
}

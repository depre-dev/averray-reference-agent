import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { registerMcpProcess } from "../../packages/mcp-common/src/bundle-registry.js";
import {
  bundleDriftSignature,
  compareBundle,
  describeBundleObservation,
  readMcpProcessRegistry,
  readPublishedBundleId,
  type LiveMcpProcess,
  type RegistryReading
} from "../../services/skills-observer/src/bundle-drift.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function makeDir(files: Record<string, string> = {}): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bundle-drift-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  }
  return root;
}

function reading(live: LiveMcpProcess[], unreadable: string[] = []): RegistryReading {
  return { live, unreadable };
}

function live(overrides: Partial<LiveMcpProcess> = {}): LiveMcpProcess {
  return {
    entry: "/app/packages/averray-mcp/dist/index.js",
    host: "hermes-1",
    pid: 41,
    startedAt: "2026-08-02T01:00:00.000Z",
    bundleId: "sha:08b214e",
    ageMs: 1_000,
    ...overrides
  };
}

describe("compareBundle", () => {
  it("agrees only when every live process is on the published bundle", () => {
    const observation = compareBundle("sha:08b214e", reading([live(), live({ host: "gateway-1" })]));

    expect(observation.kind).toBe("current");
  });

  it("reports the processes still serving an older bundle", () => {
    const observation = compareBundle("sha:08b214e", reading([
      live(),
      live({ host: "gateway-1", bundleId: "sha:7332d80" })
    ]));

    expect(observation).toMatchObject({ kind: "stale" });
    if (observation.kind !== "stale") throw new Error("expected stale");
    expect(observation.stale.map((entry) => entry.host)).toEqual(["gateway-1"]);
  });

  it("does not read an unreadable bundle stamp as agreement", () => {
    expect(compareBundle(undefined, reading([live()])).kind).toBe("unknown");
  });

  it("does not let two unknowns match each other", () => {
    // A process that could not read its stamp and a bundle published without
    // one both say "unknown". Comparing those as equal would manufacture
    // agreement out of two absences of evidence.
    const observation = compareBundle("unknown", reading([live({ bundleId: "unknown" })]));

    expect(observation.kind).toBe("unknown");
  });

  it("reads no records as unknown, never as healthy", () => {
    // This is the whole point: a stale tool registry looks exactly like a
    // working agent, so silence must not be reported as agreement.
    const observation = compareBundle("sha:08b214e", reading([]));

    expect(observation.kind).toBe("unknown");
    if (observation.kind !== "unknown") throw new Error("expected unknown");
    expect(observation.reason).toContain("no MCP server process is recording");
  });

  it("withholds agreement while any record is unaccounted for", () => {
    // The dangerous shape: every record we COULD read matches, so the survivors
    // look unanimous — but the one we could not read could be the stale one.
    const observation = compareBundle("sha:08b214e", reading([live()], ["gateway-1__averray.json"]));

    expect(observation.kind).toBe("unknown");
    if (observation.kind !== "unknown") throw new Error("expected unknown");
    expect(observation.reason).toContain("gateway-1__averray.json");
  });

  it("still reports a demonstrably stale process rather than burying it in the caveat", () => {
    const observation = compareBundle(
      "sha:08b214e",
      reading([live({ host: "gateway-1", bundleId: "sha:7332d80" })], ["torn.json"])
    );

    expect(observation.kind).toBe("stale");
  });
});

describe("bundleDriftSignature", () => {
  it("is stable regardless of the order the records were read in", () => {
    const a = live({ host: "gateway-1", bundleId: "sha:old" });
    const b = live({ host: "gateway-2", bundleId: "sha:old" });

    expect(bundleDriftSignature([a, b])).toBe(bundleDriftSignature([b, a]));
  });

  it("changes when a different consumer goes stale", () => {
    const first = bundleDriftSignature([live({ host: "gateway-1", bundleId: "sha:old" })]);
    const second = bundleDriftSignature([live({ host: "hermes-1", bundleId: "sha:old" })]);

    expect(first).not.toBe(second);
  });
});

describe("describeBundleObservation", () => {
  it("names the containers, what they run, and what they should run", () => {
    const observation = compareBundle("sha:08b214e", reading([
      live(),
      live({ host: "gateway-1", bundleId: "sha:7332d80" })
    ]));

    const description = describeBundleObservation(observation, "sha:08b214e");
    expect(description).toContain("gateway-1");
    expect(description).toContain("sha:7332d80");
    expect(description).toContain("sha:08b214e");
  });

  it("names which containers a 'current' verdict actually speaks for", () => {
    // The check is blind to a consumer whose records never arrive, so "current"
    // must not read as fleet-wide coverage. Naming the containers is what lets
    // an operator who knows there should be two notice that it saw one.
    const description = describeBundleObservation(
      compareBundle("sha:08b214e", reading([live({ host: "hermes-1" })])),
      "sha:08b214e"
    );

    expect(description).toContain("hermes-1");
    expect(description).toContain("only for containers that record");
  });
});

describe("readMcpProcessRegistry", () => {
  it("ignores records that have stopped being refreshed", async () => {
    const now = 1_000_000_000_000;
    const dir = await makeDir({
      "fresh.json": JSON.stringify(live({ host: "hermes-1" })),
      "abandoned.json": JSON.stringify(live({ host: "gone-1" }))
    });
    fs.utimesSync(path.join(dir, "fresh.json"), new Date(now - 1_000), new Date(now - 1_000));
    fs.utimesSync(
      path.join(dir, "abandoned.json"),
      new Date(now - 600_000),
      new Date(now - 600_000)
    );

    const found = await readMcpProcessRegistry(dir, now);

    // A record left by a container that is gone would otherwise report drift
    // forever, and an alert that never clears is one nobody reads. An expired
    // record was read successfully, so it is not "unaccounted for" either.
    expect(found.live.map((entry) => entry.host)).toEqual(["hermes-1"]);
    expect(found.unreadable).toEqual([]);
  });

  it("counts records it cannot read instead of quietly dropping them", async () => {
    const now = Date.now();
    const dir = await makeDir({
      "good.json": JSON.stringify(live({ host: "hermes-1" })),
      "half-written.json": "{ not json",
      "wrong-shape.json": JSON.stringify({ entry: 5 }),
      "README.txt": "ignored"
    });

    const found = await readMcpProcessRegistry(dir, now);

    expect(found.live.map((entry) => entry.host)).toEqual(["hermes-1"]);
    expect(found.unreadable).toEqual(["half-written.json", "wrong-shape.json"]);
  });

  it("throws ENOENT for an absent registry, so the caller can tell it apart from empty", async () => {
    // "Nobody has recorded anything yet" and "the check could not run" are
    // different conditions and get different wording.
    await expect(
      readMcpProcessRegistry(path.join(await makeDir(), "absent"), Date.now())
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the writer and the reader agree", () => {
  // The record format spans two packages: mcp-common writes it inside the
  // consumer, skills-observer reads it from a different container. Nothing
  // else forces those two to keep matching, and a silently unreadable record
  // would put the check straight back into the silence it exists to end.
  it("catches a consumer left on the previous bundle after the volume is republished", async () => {
    const bundle = await makeDir({
      ".mcp-bundle-id": "sha:7332d80",
      "packages/averray-mcp/dist/index.js": "//"
    });
    const registry = path.join(await makeDir(), "registry");
    const entryPath = path.join(bundle, "packages/averray-mcp/dist/index.js");

    // The consumer starts, and registers its tool list from what it loaded.
    registerMcpProcess({ entryPath, directory: registry, heartbeatMs: 60_000 });

    // A deploy republishes the volume. The running process is not restarted,
    // so its tool list is now the previous bundle's — and nothing errors.
    await fsp.writeFile(path.join(bundle, ".mcp-bundle-id"), "sha:08b214e\n");

    const published = await readPublishedBundleId(bundle);
    const observation = compareBundle(published, await readMcpProcessRegistry(registry, Date.now()));

    expect(observation.kind).toBe("stale");
    expect(describeBundleObservation(observation, published)).toContain("sha:7332d80");
  });

  it("reports current once that consumer restarts", async () => {
    const bundle = await makeDir({
      ".mcp-bundle-id": "sha:08b214e",
      "packages/averray-mcp/dist/index.js": "//"
    });
    const registry = path.join(await makeDir(), "registry");
    const entryPath = path.join(bundle, "packages/averray-mcp/dist/index.js");

    registerMcpProcess({ entryPath, directory: registry, heartbeatMs: 60_000 });
    // A restart re-registers over its own record rather than adding a second
    // one, or the restarted consumer would keep looking stale forever.
    registerMcpProcess({ entryPath, directory: registry, heartbeatMs: 60_000 });

    const found = await readMcpProcessRegistry(registry, Date.now());
    expect(found.live).toHaveLength(1);
    expect(compareBundle(await readPublishedBundleId(bundle), found).kind).toBe("current");
  });
});

describe("readPublishedBundleId", () => {
  it("reads the stamp mcp-bundle wrote", async () => {
    const dir = await makeDir({ ".mcp-bundle-id": "sha:08b214e\n" });

    expect(await readPublishedBundleId(dir)).toBe("sha:08b214e");
  });

  it("returns nothing when the bundle is not mounted or not stamped", async () => {
    expect(await readPublishedBundleId(path.join(await makeDir(), "absent"))).toBeUndefined();
  });
});

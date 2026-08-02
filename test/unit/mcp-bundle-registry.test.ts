import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UNKNOWN_BUNDLE_ID,
  buildMcpProcessRecord,
  bundleRecordFileName,
  pruneMcpProcessRecords,
  readBundleId,
  registerMcpProcess,
  writeMcpProcessRecord
} from "../../packages/mcp-common/src/bundle-registry.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    await fsp.chmod(root, 0o755).catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function makeDir(files: Record<string, string> = {}): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-bundle-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  }
  return root;
}

describe("readBundleId", () => {
  it("finds the stamp by climbing from the file that was executed", async () => {
    const root = await makeDir({
      ".mcp-bundle-id": "sha:08b214e\n",
      "packages/averray-mcp/dist/index.js": "//"
    });

    expect(readBundleId(path.join(root, "packages/averray-mcp/dist/index.js"))).toBe("sha:08b214e");
  });

  it("reports unknown when the bundle carries no stamp", async () => {
    const root = await makeDir({ "packages/averray-mcp/dist/index.js": "//" });

    expect(readBundleId(path.join(root, "packages/averray-mcp/dist/index.js"))).toBe(
      UNKNOWN_BUNDLE_ID
    );
  });

  it("treats an empty stamp as no stamp rather than as an id", async () => {
    // An empty id would compare equal to another empty id, which is agreement
    // conjured out of two unknowns.
    const root = await makeDir({ ".mcp-bundle-id": "  \n", "dist/index.js": "//" });

    expect(readBundleId(path.join(root, "dist/index.js"))).toBe(UNKNOWN_BUNDLE_ID);
  });
});

describe("bundleRecordFileName", () => {
  it("is stable for a consumer and entry, so a restart overwrites its own record", () => {
    const first = bundleRecordFileName("hermes-1", "/app/packages/averray-mcp/dist/index.js");
    const second = bundleRecordFileName("hermes-1", "/app/packages/averray-mcp/dist/index.js");

    expect(first).toBe(second);
    expect(first.endsWith(".json")).toBe(true);
  });

  it("separates consumers and entry points", () => {
    const gateway = bundleRecordFileName("gateway-1", "/app/packages/averray-mcp/dist/index.js");
    const hermes = bundleRecordFileName("hermes-1", "/app/packages/averray-mcp/dist/index.js");
    const otherEntry = bundleRecordFileName("hermes-1", "/app/packages/wallet-mcp/dist/index.js");

    expect(new Set([gateway, hermes, otherEntry]).size).toBe(3);
  });
});

describe("writeMcpProcessRecord", () => {
  it("writes a record that round-trips", async () => {
    const dir = path.join(await makeDir(), "registry");
    const record = buildMcpProcessRecord("/app/packages/averray-mcp/dist/index.js", new Date(0));

    expect(writeMcpProcessRecord(dir, record)).toBe(true);
    const written = JSON.parse(
      await fsp.readFile(path.join(dir, bundleRecordFileName(record.host, record.entry)), "utf8")
    );
    expect(written).toMatchObject({
      entry: "/app/packages/averray-mcp/dist/index.js",
      bundleId: UNKNOWN_BUNDLE_ID,
      startedAt: "1970-01-01T00:00:00.000Z"
    });
  });

  it("reports failure instead of throwing when the registry cannot be written", async () => {
    // An observability record that can take down the agent's tool surface would
    // be a worse bug than the one it reports.
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const root = await makeDir();
    await fsp.chmod(root, 0o500);
    const record = buildMcpProcessRecord("/app/packages/averray-mcp/dist/index.js", new Date(0));

    expect(writeMcpProcessRecord(path.join(root, "registry"), record)).toBe(false);
  });
});

describe("pruneMcpProcessRecords", () => {
  it("removes records old enough to be from containers that no longer exist", async () => {
    const now = 1_000_000_000_000;
    const dir = await makeDir({ "fresh.json": "{}", "ancient.json": "{}", "notes.txt": "keep" });
    fs.utimesSync(path.join(dir, "ancient.json"), new Date(now - 90_000), new Date(now - 90_000));
    fs.utimesSync(path.join(dir, "fresh.json"), new Date(now - 1_000), new Date(now - 1_000));

    expect(pruneMcpProcessRecords(dir, now, 60_000)).toBe(1);
    expect((await fsp.readdir(dir)).sort()).toEqual(["fresh.json", "notes.txt"]);
  });

  it("returns zero rather than throwing when the registry does not exist", async () => {
    expect(pruneMcpProcessRecords(path.join(await makeDir(), "absent"), Date.now(), 1)).toBe(0);
  });
});

describe("registerMcpProcess", () => {
  it("records the bundle the entry was actually loaded from", async () => {
    const bundle = await makeDir({
      ".mcp-bundle-id": "sha:08b214e",
      "packages/averray-mcp/dist/index.js": "//"
    });
    const registry = path.join(await makeDir(), "registry");
    const entryPath = path.join(bundle, "packages/averray-mcp/dist/index.js");

    registerMcpProcess({ entryPath, directory: registry, heartbeatMs: 10_000 });

    const [name] = await fsp.readdir(registry);
    const record = JSON.parse(await fsp.readFile(path.join(registry, name), "utf8"));
    expect(record.bundleId).toBe("sha:08b214e");
    expect(record.entry).toBe(entryPath);
  });

  it("keeps the record alive, so a dead process's stamp ages out instead of alarming forever", async () => {
    vi.useFakeTimers();
    const registry = path.join(await makeDir(), "registry");
    registerMcpProcess({
      entryPath: "/app/packages/averray-mcp/dist/index.js",
      directory: registry,
      heartbeatMs: 1_000
    });
    const [name] = await fsp.readdir(registry);
    await fsp.rm(path.join(registry, name));

    vi.advanceTimersByTime(1_000);

    // Rewritten, not merely touched — a record deleted out from under the
    // process comes back rather than reading as a process that has gone.
    expect(await fsp.readdir(registry)).toEqual([name]);
  });

  it("does nothing at all when there is no entry path to describe", () => {
    expect(() => registerMcpProcess({ entryPath: "", directory: "/proc/definitely-not" })).not.toThrow();
  });
});

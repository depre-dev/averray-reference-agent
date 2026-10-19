import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Log cap for the monitor stack. `ops/deploy-monitor.sh` is the source of the
 * file list: anchors cannot cross compose files, so each loaded file that
 * defines services repeats the same anchor and points every service at it.
 */
const LOG_CAP = {
  driver: "json-file",
  options: {
    "max-size": "10m",
    "max-file": "5",
  },
} as const;

const ANCHOR = "json-file-log-cap";

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** Compose files named by `-f` in deploy-monitor.sh, in load order. */
export function composeFilesLoadedByDeployMonitor(script: string): string[] {
  const files: string[] = [];
  for (const match of script.matchAll(/-f (ops\/compose(?:\.[a-z0-9-]+)?\.yml)/g)) {
    const file = match[1];
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/** Service names under the top-level `services:` map. Volumes and networks are not services. */
export function serviceNames(text: string): string[] {
  const names: string[] = [];
  let inServices = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inServices) {
      if (line === "services:") inServices = true;
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) break;
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function serviceBlock(text: string, serviceName: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) break;
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("monitor stack json-file log cap", () => {
  const deployScript = readText("../../ops/deploy-monitor.sh");
  const composeFiles = composeFilesLoadedByDeployMonitor(deployScript);

  it("follows the compose files deploy-monitor.sh loads", () => {
    expect(composeFiles).toEqual([
      "ops/compose.yml",
      "ops/compose.prod.yml",
      "ops/compose.command-center.yml",
      "ops/compose.cloudflare-access.yml",
      "ops/compose.bank-feed.yml",
    ]);
  });

  it("applies one shared logging anchor to every service in those files", () => {
    const filesWithServices: string[] = [];

    for (const file of composeFiles) {
      const text = readText(`../../${file}`);
      const names = serviceNames(text);
      if (names.length === 0) continue;
      filesWithServices.push(file);

      const anchorDefs = text.match(new RegExp(`&${ANCHOR}\\b`, "g")) ?? [];
      expect(anchorDefs, `${file} defines the logging anchor once`).toHaveLength(1);

      const parsed = parse(text) as {
        services?: Record<string, { logging?: unknown } | null>;
      };

      for (const name of names) {
        expect(serviceBlock(text, name), `${file} service ${name} must reference *${ANCHOR}`).toMatch(
          new RegExp(`^    logging: \\*${ANCHOR}$`, "m"),
        );
        expect(parsed.services?.[name]?.logging, `${file} service ${name}`).toEqual(LOG_CAP);
      }
    }

    expect(filesWithServices).toEqual(composeFiles);
    expect(filesWithServices.length).toBeGreaterThan(0);
  });
});

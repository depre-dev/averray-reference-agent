import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function readYamlFile<T>(filePath: string, fallback: T): T {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  const absolute = path.resolve(filePath);
  return YAML.parse(fs.readFileSync(absolute, "utf8")) as T;
}


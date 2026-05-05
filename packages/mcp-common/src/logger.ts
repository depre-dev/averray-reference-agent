import pino from "pino";
import { Writable } from "node:stream";

const stderrStream = new Writable({
  write(chunk, encoding, callback) {
    process.stderr.write(chunk, encoding, callback);
  }
});

export function createLogger(stream: NodeJS.WritableStream = stderrStream) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "privateKey",
        "*.privateKey",
        "authorization",
        "*.authorization",
        "signature",
        "*.signature",
        "cookie",
        "*.cookie",
        "*.jwt",
        "jwt",
        "mnemonic",
        "*.mnemonic"
      ],
      censor: "[redacted]"
    }
  }, stream);
}

export const logger = createLogger();

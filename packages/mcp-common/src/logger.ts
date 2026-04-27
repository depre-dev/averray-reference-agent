import pino from "pino";

export const logger = pino({
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
});


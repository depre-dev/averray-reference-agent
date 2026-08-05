import { appendFile, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const target = process.env.INT4A_FAKE_SLACK_DELIVERIES_PATH
  ?? "/evidence/slack-deliveries.jsonl";
const port = Number(process.env.INT4A_FAKE_SLACK_PORT ?? "8080");

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok\n");
    return;
  }
  if (request.method !== "POST" || request.url !== "/hook") {
    response.writeHead(404);
    response.end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    void (async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, `${body}\n`, "utf8");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.info(`INT4A_FAKE_SLACK_READY port=${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      process.exitCode = 0;
    });
  });
}

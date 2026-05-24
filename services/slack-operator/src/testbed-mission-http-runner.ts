import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface HttpMissionReport {
  verdict: "pass" | "partial" | "fail";
  confidence: number;
  stoppedBeforeMutation: boolean;
  completedPath?: string[];
  blockers: string[];
  confusingMoments?: string[];
  evidence: Array<{ type: string; value: string }>;
  scores: Record<string, number>;
  recommendations?: string[];
}

export async function runHttpTestbedMission(env: NodeJS.ProcessEnv = process.env): Promise<HttpMissionReport> {
  const targetUrl = requiredEnv(env, "TESTBED_TARGET_URL");
  const goal = env.TESTBED_MISSION_GOAL || "test first-contact usability";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref();
  try {
    const response = await fetch(targetUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Averray-Hermes-Testbed-Runner/1.0",
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const text = visibleText(body);
    const hasGoalHint = goalWords(goal).some((word) => text.toLowerCase().includes(word));
    const ok = response.ok && text.length > 0;
    const verdict = ok ? "pass" : "fail";
    return {
      verdict,
      confidence: ok ? 0.72 : 0.35,
      stoppedBeforeMutation: true,
      ...(ok ? { completedPath: [`opened ${targetUrl}`, "loaded first page without mutating state"] } : {}),
      blockers: ok ? [] : [`HTTP ${response.status} while loading ${targetUrl}`],
      confusingMoments: hasGoalHint || !ok ? [] : [`The first page loaded, but I did not see words tied to the goal: ${goal}.`],
      evidence: [
        { type: "http_status", value: `${response.status} ${response.statusText}` },
        { type: "content_type", value: contentType || "unknown" },
        { type: "visible_text_sample", value: text.slice(0, 500) || "[no visible text]" },
      ],
      scores: {
        pageLoads: response.ok ? 5 : 1,
        orientation: hasGoalHint ? 4 : ok ? 3 : 1,
        mutationSafety: 5,
        evidenceQuality: ok ? 3 : 2,
      },
      recommendations: ok && !hasGoalHint
        ? ["Make the page's first-screen copy mirror the mission goal so a fresh agent knows where it is."]
        : [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const report = await runHttpTestbedMission();
  const output = JSON.stringify(report, null, 2);
  if (process.env.TESTBED_MISSION_REPORT_PATH) {
    await writeFile(process.env.TESTBED_MISSION_REPORT_PATH, `${output}\n`);
  }
  console.log(output);
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function goalWords(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .slice(0, 8);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

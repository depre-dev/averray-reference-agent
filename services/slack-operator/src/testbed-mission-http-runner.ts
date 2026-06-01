import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface HttpMissionReport {
  verdict: "pass" | "partial" | "fail";
  confidence: number;
  executor: "http_visibility_check";
  runnerMode: "non_browser_fetch";
  stoppedBeforeMutation: boolean;
  mutationBoundaryNotes: string[];
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
  if (isGatedAppTarget(targetUrl, env)) {
    return {
      verdict: "fail",
      confidence: 0,
      executor: "http_visibility_check",
      runnerMode: "non_browser_fetch",
      stoppedBeforeMutation: true,
      mutationBoundaryNotes: ["HTTP visibility check is public-only and refused the gated app before sending a request."],
      blockers: [
        `http_visibility_check is public-only; gated target ${targetUrl} requires the browser-capable executor with Cloudflare Access edge auth and a T2/T3 authenticated session.`,
      ],
      confusingMoments: [],
      evidence: [
        { type: "executor", value: "http_visibility_check; refused gated target before network request" },
        { type: "target_classification", value: "gated_app" },
      ],
      scores: {
        pageLoads: 0,
        orientation: 0,
        mutationSafety: 5,
        evidenceQuality: 3,
      },
      recommendations: [
        "Use the Playwright surface-sweep executor with TESTBED_CF_ACCESS_CLIENT_ID/SECRET plus a T2/T3 session, or run a T4 gold-path mission with TESTBED_GOLDPATH_LIVE=1.",
      ],
    };
  }
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
    const verdict = ok ? "partial" : "fail";
    return {
      verdict,
      confidence: ok ? 0.46 : 0.2,
      executor: "http_visibility_check",
      runnerMode: "non_browser_fetch",
      stoppedBeforeMutation: true,
      mutationBoundaryNotes: ["HTTP visibility check never interacts with page controls, so it stops before every mutation boundary."],
      ...(ok ? { completedPath: [`opened ${targetUrl}`, "loaded first page without mutating state"] } : {}),
      blockers: ok
        ? ["HTTP visibility check loaded the page, but no real browser interaction ran yet."]
        : [`HTTP ${response.status} while loading ${targetUrl}`],
      confusingMoments: hasGoalHint || !ok ? [] : [`The first page loaded, but I did not see words tied to the goal: ${goal}.`],
      evidence: [
        { type: "executor", value: "http_visibility_check; not a full browser-agent run" },
        { type: "http_status", value: `${response.status} ${response.statusText}` },
        { type: "content_type", value: contentType || "unknown" },
        { type: "visible_text_sample", value: text.slice(0, 500) || "[no visible text]" },
      ],
      scores: {
        pageLoads: response.ok ? 5 : 1,
        orientation: hasGoalHint ? 4 : ok ? 3 : 1,
        mutationSafety: 5,
        evidenceQuality: ok ? 2 : 2,
      },
      recommendations: [
        "Run the same mission with a browser-capable executor before treating it as outside-agent evidence.",
        ...(ok && !hasGoalHint
          ? ["Make the page's first-screen copy mirror the mission goal so a fresh agent knows where it is."]
          : []),
      ],
    };
  } catch (error) {
    const detail = formatErrorWithCause(error);
    return {
      verdict: "fail",
      confidence: 0,
      executor: "http_visibility_check",
      runnerMode: "non_browser_fetch",
      stoppedBeforeMutation: true,
      mutationBoundaryNotes: ["HTTP visibility check failed before any browser interaction or mutation boundary."],
      blockers: [`Could not load ${targetUrl}: ${detail}`],
      confusingMoments: [],
      evidence: [
        { type: "executor", value: "http_visibility_check; target did not load" },
        { type: "network_error", value: detail },
      ],
      scores: {
        pageLoads: 0,
        orientation: 0,
        mutationSafety: 5,
        evidenceQuality: 2,
      },
      recommendations: [
        "Check DNS, tunnel, or target URL reachability from the runner container, then rerun the mission.",
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isGatedAppTarget(targetUrl: string, env: NodeJS.ProcessEnv): boolean {
  const hosts = (env.TESTBED_HTTP_GATED_HOSTS || "app.averray.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) return false;
  try {
    const url = new URL(targetUrl);
    return hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
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

function formatErrorWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) return `${error.message}: ${cause.message}`;
  if (cause && typeof cause === "object") {
    const fields = cause as { code?: unknown; hostname?: unknown; message?: unknown };
    const parts = [
      fields.message ? String(fields.message) : "",
      fields.code ? String(fields.code) : "",
      fields.hostname ? String(fields.hostname) : "",
    ].filter(Boolean);
    if (parts.length) return `${error.message}: ${parts.join(" ")}`;
  }
  return error.message;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

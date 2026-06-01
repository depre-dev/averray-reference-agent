import { afterEach, describe, expect, it, vi } from "vitest";

import { runHttpTestbedMission } from "../../services/slack-operator/src/testbed-mission-http-runner.js";

describe("testbed mission HTTP runner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks a fetched page as partial evidence, not a completed browser mission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><body>Averray trust infrastructure for agents</body></html>",
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }
    )));

    const report = await runHttpTestbedMission({
      TESTBED_TARGET_URL: "https://averray.example",
      TESTBED_MISSION_GOAL: "Test main flow",
    });

    expect(report).toMatchObject({
      verdict: "partial",
      executor: "http_visibility_check",
      runnerMode: "non_browser_fetch",
      stoppedBeforeMutation: true,
      blockers: ["HTTP visibility check loaded the page, but no real browser interaction ran yet."],
    });
    expect(report.recommendations).toContain("Run the same mission with a browser-capable executor before treating it as outside-agent evidence.");
  });

  it("returns a structured mission failure when the target cannot be reached", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND testbed.averray.com"), {
      code: "ENOTFOUND",
      hostname: "testbed.averray.com",
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed", { cause });
    }));

    const report = await runHttpTestbedMission({
      TESTBED_TARGET_URL: "https://testbed.averray.com",
      TESTBED_MISSION_GOAL: "Test main flow",
    });

    expect(report).toMatchObject({
      verdict: "fail",
      confidence: 0,
      executor: "http_visibility_check",
      blockers: [
        "Could not load https://testbed.averray.com: fetch failed: getaddrinfo ENOTFOUND testbed.averray.com",
      ],
      evidence: expect.arrayContaining([
        {
          type: "network_error",
          value: "fetch failed: getaddrinfo ENOTFOUND testbed.averray.com",
        },
      ]),
    });
  });

  it("refuses the gated operator app before making a non-browser HTTP probe", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const report = await runHttpTestbedMission({
      TESTBED_TARGET_URL: "https://app.averray.com",
      TESTBED_MISSION_GOAL: "Load the operator app",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      verdict: "fail",
      executor: "http_visibility_check",
      blockers: [
        expect.stringContaining("gated target https://app.averray.com requires the browser-capable executor"),
      ],
      evidence: expect.arrayContaining([
        { type: "target_classification", value: "gated_app" },
      ]),
    });
    expect(report.blockers.join(" ")).not.toContain("HTTP 401");
  });
});

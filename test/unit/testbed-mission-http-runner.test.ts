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

  it("refuses the gated operator app when NO Basic Auth credential is configured", async () => {
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
        expect.stringContaining("behind Caddy HTTP Basic Auth"),
      ],
      evidence: expect.arrayContaining([
        { type: "target_classification", value: "gated_app" },
      ]),
    });
    expect(report.blockers.join(" ")).not.toContain("HTTP 401");
  });

  it("loads the gated app with Authorization: Basic when the credential IS configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "<html><body>Averray Operator overview</body></html>",
      { status: 200, statusText: "OK", headers: { "content-type": "text/html" } },
    ));
    vi.stubGlobal("fetch", fetchImpl);

    const report = await runHttpTestbedMission({
      TESTBED_TARGET_URL: "https://app.averray.com/overview",
      TESTBED_MISSION_GOAL: "Load the operator app",
      TESTBED_BASIC_AUTH_USER: "op",
      TESTBED_BASIC_AUTH_PASS: "s3cr3t-pass",
    });

    // It sent the request (no refusal) carrying the Basic Auth header.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from("op:s3cr3t-pass").toString("base64")}`);
    expect(report).toMatchObject({ verdict: "partial", executor: "http_visibility_check" });
    // The credential never appears in the report.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("s3cr3t-pass");
    expect(serialized).not.toContain(Buffer.from("op:s3cr3t-pass").toString("base64"));
  });

  it("only sends Basic Auth to the configured gated host, never to other origins", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html><body>public</body></html>", {
      status: 200, statusText: "OK", headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchImpl);

    await runHttpTestbedMission({
      TESTBED_TARGET_URL: "https://public.averray.com/",
      TESTBED_MISSION_GOAL: "Load a public page",
      TESTBED_BASIC_AUTH_USER: "op",
      TESTBED_BASIC_AUTH_PASS: "s3cr3t-pass",
    });

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

import { describe, expect, test } from "vitest";
import { missionLaunchBody, type MissionLaunchInput } from "./mission-launch.js";

const base: Omit<MissionLaunchInput, "mode"> = {
  targetUrl: "https://app.averray.com",
  freshMemory: true,
  initialStatus: "ready",
};

describe("missionLaunchBody — mode → POST body", () => {
  test("citation_repair carries jobId and OMITS targetUrl", () => {
    const body = missionLaunchBody({ ...base, mode: "citation_repair", jobId: "wiki-en-62871101" });
    expect(body).toEqual({
      mode: "citation_repair",
      jobId: "wiki-en-62871101",
      freshMemory: true,
      initialStatus: "ready",
    });
    expect(body).not.toHaveProperty("targetUrl");
  });

  test("citation_repair with no jobId omits jobId (server auto-selects) and targetUrl", () => {
    const body = missionLaunchBody({ ...base, targetUrl: "", mode: "citation_repair" });
    expect(body).toEqual({ mode: "citation_repair", freshMemory: true, initialStatus: "ready" });
    expect(body).not.toHaveProperty("jobId");
    expect(body).not.toHaveProperty("targetUrl");
  });

  test("existing flows are unchanged: surface_sweep keeps targetUrl, no jobId", () => {
    const body = missionLaunchBody({ ...base, mode: "surface_sweep" });
    expect(body).toEqual({
      targetUrl: "https://app.averray.com",
      mode: "surface_sweep",
      freshMemory: true,
      initialStatus: "ready",
    });
    expect(body).not.toHaveProperty("jobId");
  });

  test("a bare string spawn stays a plain targetUrl body", () => {
    expect(missionLaunchBody("https://example.test")).toEqual({ targetUrl: "https://example.test" });
  });
});

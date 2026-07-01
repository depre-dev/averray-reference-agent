import { describe, expect, it } from "vitest";
import { shortId } from "./card-id.js";

describe("shortId", () => {
  it("strips the leading agent-type prefix", () => {
    expect(shortId("agent #548")).toBe("#548");
    expect(shortId("mission browser-onboard-04")).toBe("browser-onboard-04");
  });

  it("collapses long codex/claude machine task ids to a short handle", () => {
    expect(shortId("codex-task-averray-agent-agent-new-20260701T142620409Z-vfs58z")).toBe("task vfs58z");
    // tolerates a leading "task " type prefix too
    expect(shortId("task codex-task-averray-agent-agent-new-20260701T142620409Z-vfs58z")).toBe("task vfs58z");
  });

  it("leaves PR refs and short slugs untouched", () => {
    expect(shortId("#711")).toBe("#711");
    expect(shortId("starter-coding-014")).toBe("starter-coding-014");
    expect(shortId("browser-onboard-04")).toBe("browser-onboard-04");
  });
});

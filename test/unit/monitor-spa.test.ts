import { describe, expect, it } from "vitest";

import {
  MONITOR_SPA_MOUNT,
  contentTypeFor,
  resolveSpaRequest,
} from "../../services/slack-operator/src/monitor-spa.js";

describe("resolveSpaRequest", () => {
  it("mounts at /monitor (the default board after cutover)", () => {
    expect(MONITOR_SPA_MOUNT).toBe("/monitor");
  });

  it("redirects the bare mount to a trailing slash (so relative asset URLs resolve)", () => {
    expect(resolveSpaRequest(MONITOR_SPA_MOUNT)).toEqual({
      kind: "redirect",
      location: "/monitor/",
    });
  });

  it("serves index.html at the mount root", () => {
    expect(resolveSpaRequest("/monitor/")).toEqual({ kind: "index" });
  });

  it("serves hashed assets with a content type", () => {
    expect(resolveSpaRequest("/monitor/assets/index-abc123.js")).toEqual({
      kind: "asset",
      relPath: "assets/index-abc123.js",
      contentType: "text/javascript; charset=utf-8",
    });
    expect(resolveSpaRequest("/monitor/assets/index-abc123.css").contentType).toBe("text/css; charset=utf-8");
  });

  it("rejects traversal, nested paths, and NUL", () => {
    expect(resolveSpaRequest("/monitor/assets/../../etc/passwd").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/assets/sub/dir.js").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/assets/x\0.js").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/assets/").kind).toBe("miss");
  });

  it("misses sibling API + legacy paths so they fall through to their handlers", () => {
    // These must NOT be claimed by the SPA — they have their own routes.
    expect(resolveSpaRequest("/monitor/v2/board").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/v2/stream").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/events").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/codex-tasks").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/collaboration").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/review-requests").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/testbed-missions").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/legacy").kind).toBe("miss");
    // The old preview path is a miss here (index.ts 302s it to /monitor/).
    expect(resolveSpaRequest("/monitor/next").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor-other").kind).toBe("miss");
  });
});

describe("contentTypeFor", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("a.html")).toMatch(/text\/html/);
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});

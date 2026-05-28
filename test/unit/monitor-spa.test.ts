import { describe, expect, it } from "vitest";

import {
  MONITOR_SPA_MOUNT,
  contentTypeFor,
  resolveSpaRequest,
} from "../../services/slack-operator/src/monitor-spa.js";

describe("resolveSpaRequest", () => {
  it("redirects the bare mount to a trailing slash (so relative asset URLs resolve)", () => {
    expect(resolveSpaRequest(MONITOR_SPA_MOUNT)).toEqual({
      kind: "redirect",
      location: "/monitor/next/",
    });
  });

  it("serves index.html at the mount root", () => {
    expect(resolveSpaRequest("/monitor/next/")).toEqual({ kind: "index" });
  });

  it("serves hashed assets with a content type", () => {
    expect(resolveSpaRequest("/monitor/next/assets/index-abc123.js")).toEqual({
      kind: "asset",
      relPath: "assets/index-abc123.js",
      contentType: "text/javascript; charset=utf-8",
    });
    expect(resolveSpaRequest("/monitor/next/assets/index-abc123.css").contentType).toBe("text/css; charset=utf-8");
  });

  it("rejects traversal, nested paths, and NUL", () => {
    expect(resolveSpaRequest("/monitor/next/assets/../../etc/passwd").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/next/assets/sub/dir.js").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/next/assets/x\0.js").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/next/assets/").kind).toBe("miss");
  });

  it("misses paths outside the mount", () => {
    expect(resolveSpaRequest("/monitor").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/next-other").kind).toBe("miss");
    expect(resolveSpaRequest("/monitor/v2/board").kind).toBe("miss");
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

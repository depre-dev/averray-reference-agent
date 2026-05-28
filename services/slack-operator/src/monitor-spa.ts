// Hermes Handoff Monitor — static serving of the redesigned SPA (§20).
//
// slack-operator serves the Vite-built bundle (packages/monitor-ui/dist)
// alongside the legacy HTML monitor. The new board mounts at
// /monitor/next while the legacy monitor keeps /monitor, so the redesign
// can be previewed in production before the cutover.
//
// This module is the pure request → resolution mapping (tested); the
// HTTP handler in index.ts does the filesystem read + response.

export const MONITOR_SPA_MOUNT = "/monitor/next";

export type SpaResolution =
  | { kind: "redirect"; location: string }
  | { kind: "index" }
  | { kind: "asset"; relPath: string; contentType: string }
  | { kind: "miss" };

/**
 * Map a request path under the SPA mount to what should be served.
 *   /monitor/next            → redirect to /monitor/next/ (so the SPA's
 *                              relative asset URLs resolve correctly)
 *   /monitor/next/           → index.html
 *   /monitor/next/assets/... → the hashed asset
 *   anything else            → miss
 */
export function resolveSpaRequest(pathname: string, mount: string = MONITOR_SPA_MOUNT): SpaResolution {
  if (pathname === mount) return { kind: "redirect", location: `${mount}/` };
  if (pathname === `${mount}/`) return { kind: "index" };

  const assetsPrefix = `${mount}/assets/`;
  if (pathname.startsWith(assetsPrefix)) {
    const file = pathname.slice(assetsPrefix.length);
    // No traversal, no nested paths, no NUL — hashed asset filenames only.
    if (!file || file.includes("..") || file.includes("/") || file.includes("\0")) {
      return { kind: "miss" };
    }
    const relPath = `assets/${file}`;
    return { kind: "asset", relPath, contentType: contentTypeFor(relPath) };
  }

  return { kind: "miss" };
}

/** Best-effort content type from a file extension. */
export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    default:
      return "application/octet-stream";
  }
}

// Hermes Handoff Monitor — tab badge (§17 tier 2, §21.2).
//
// Two badge surfaces, both best-effort and feature-detected:
//   - the OS/taskbar badge via the Badging API (navigator.setAppBadge)
//   - a canvas-rendered favicon with a count bubble (the dock/tab dot)
//
// Everything degrades to a no-op where unsupported (e.g. jsdom has no 2D
// canvas context), so callers can fire-and-forget on every count change.

interface BadgingNavigator {
  setAppBadge?: (count?: number) => Promise<void> | void;
  clearAppBadge?: () => Promise<void> | void;
}

/** OS/taskbar badge via the Badging API. */
export function setAppBadge(count: number, nav: Navigator | undefined = globalNavigator()): void {
  const n = nav as (Navigator & BadgingNavigator) | undefined;
  if (!n) return;
  try {
    if (count > 0 && typeof n.setAppBadge === "function") void n.setAppBadge(Math.floor(count));
    else if (count <= 0 && typeof n.clearAppBadge === "function") void n.clearAppBadge();
  } catch {
    /* unsupported / blocked */
  }
}

/** Canvas-rendered favicon with a count bubble. No-op without a 2D context. */
export function setFaviconBadge(count: number, doc: Document | undefined = globalDocument()): void {
  if (!doc) return;
  const link = ensureIconLink(doc);
  if (!link) return;

  let canvas: HTMLCanvasElement;
  try {
    canvas = doc.createElement("canvas");
  } catch {
    return;
  }
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return; // e.g. jsdom — leave the static favicon in place

  // Base brand dot (sage).
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = "#0f6b5a";
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();

  const n = Math.floor(count);
  if (n > 0) {
    // Amber count bubble.
    ctx.fillStyle = "#d98324";
    ctx.beginPath();
    ctx.arc(46, 18, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fffdf7";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(n > 9 ? "9+" : String(n), 46, 19);
  }

  try {
    link.href = canvas.toDataURL("image/png");
  } catch {
    /* tainted / unsupported */
  }
}

function ensureIconLink(doc: Document): HTMLLinkElement | null {
  const existing = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const head = doc.head ?? doc.querySelector("head");
  if (!head) return null;
  const link = doc.createElement("link");
  link.rel = "icon";
  head.appendChild(link);
  return link;
}

function globalDocument(): Document | undefined {
  return typeof document !== "undefined" ? document : undefined;
}

function globalNavigator(): Navigator | undefined {
  return typeof navigator !== "undefined" ? navigator : undefined;
}

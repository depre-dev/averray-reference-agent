// Hermes-4 design system — color profiles + theme engine (PR-D1).
//
// Ports docs/design/hermes-4/project/app.jsx's profile/buildTheme layer into
// the monitor. FOUNDATION-FIRST + no-fork: every custom property this engine
// writes is namespaced `--h4-*`, so it NEVER clobbers the shipped board's
// existing `--hm-*` / `--avy-*` tokens. The new D1 shell / footer / kanban-tier
// layer consumes `--h4-*`; the rest of the board keeps its current styling
// until later D-PRs migrate it onto this system.
//
// Color math is a verbatim port of the reference so the 6 profiles render
// identically.

export type ColorProfileId = "claude" | "midnight" | "slate" | "editorial" | "averray" | "midpolka";
export type MotionBucket = "off" | "low" | "med" | "high";
export type Density = "compact" | "regular" | "comfy";

export interface ColorProfile {
  label: string;
  dark: boolean;
  glow?: boolean;
  base: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  healthy: string;
  degraded: string;
  accentFill?: string;
  accentInk?: string;
}

/** The 6 profiles, verbatim from the design reference. */
export const PROFILES: Record<ColorProfileId, ColorProfile> = {
  claude: { label: "Claude Warm", dark: false, base: "#FAF7F2", surface: "#FFFDFA", ink: "#2A2622", muted: "#A89B8C", accent: "#D97757", healthy: "#6B8F71", degraded: "#C8843C" },
  midnight: { label: "Midnight", dark: true, glow: false, base: "#1A1714", surface: "#241F1B", ink: "#EDE6DD", muted: "#6B635A", accent: "#E8865E", healthy: "#7FB089", degraded: "#E0A050" },
  slate: { label: "Slate Console", dark: false, base: "#F4F5F7", surface: "#FFFFFF", ink: "#1F2430", muted: "#8A93A3", accent: "#5B6CFF", healthy: "#3FA66A", degraded: "#D9911F" },
  editorial: { label: "Editorial", dark: false, base: "#FBFAF7", surface: "#FFFFFF", ink: "#17120E", muted: "#9C948A", accent: "#B23A28", healthy: "#2F7D52", degraded: "#B5791E" },
  averray: { label: "Averray (Polkadot)", dark: false, base: "#F6F5F8", surface: "#FFFFFF", ink: "#1B1722", muted: "#8C8A99", accent: "#E6007A", healthy: "#0FA67E", degraded: "#E0A030", accentFill: "#D6006E", accentInk: "#ffffff" },
  midpolka: { label: "Midnight × Polkadot", dark: true, glow: true, base: "#14111C", surface: "#201B2E", ink: "#ECE8F2", muted: "#6B6580", accent: "#FF2D92", healthy: "#2DD4BF", degraded: "#F0B44C", accentInk: "#14111C" },
};

/** D1 default — Midnight (operator's pick). All 6 ship + are switchable. */
export const DEFAULT_PROFILE: ColorProfileId = "midnight";
export const DEFAULT_MOTION = 60;
export const DEFAULT_DENSITY: Density = "regular";

export const PROFILE_OPTIONS: ReadonlyArray<{ value: ColorProfileId; label: string }> = (
  Object.entries(PROFILES) as Array<[ColorProfileId, ColorProfile]>
).map(([value, p]) => ({ value, label: p.label }));

// ── color math (verbatim port) ──────────────────────────────────────
function hx(h: string): { r: number; g: number; b: number } {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}
function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const t = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${t(r)}${t(g)}${t(b)}`;
}
export function mix(a: string, b: string, t: number): string {
  const A = hx(a), B = hx(b);
  return toHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
export function rgba(h: string, a: number): string {
  const { r, g, b } = hx(h);
  return `rgba(${r},${g},${b},${a})`;
}
export function lighten(h: string, t: number): string {
  return mix(h, "#ffffff", t);
}
export function darken(h: string, t: number): string {
  return mix(h, "#000000", t);
}
function lum(h: string): number {
  const { r, g, b } = hx(h);
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function inkOn(bg: string): string {
  return lum(bg) > 0.42 ? "#14110c" : "#ffffff";
}

/** Slider value (0..100) → motion bucket. */
export function motionBucket(v: number): MotionBucket {
  return v <= 0 ? "off" : v <= 33 ? "low" : v <= 66 ? "med" : "high";
}

/**
 * Build the profile-dependent custom properties, keyed `--h4-*`. The constant
 * tokens (agent jewel, radii, fonts) live in hermes4-tokens.css and are not
 * re-themed. Mirrors the reference buildTheme exactly.
 */
export function buildTheme(p: ColorProfile): Record<string, string> {
  const dark = !!p.dark, glow = !!p.glow;
  const { base, surface: surf, ink, muted, accent, healthy: ok, degraded: warn } = p;
  const accFill = p.accentFill || (dark ? accent : darken(accent, 0.08));
  const accInk = p.accentInk || inkOn(accFill);
  return {
    "--h4-canvas": base,
    "--h4-surface": mix(base, surf, 0.5),
    "--h4-paper": surf,
    "--h4-paper-sunken": mix(surf, base, 0.4),
    "--h4-paper-veil": rgba(surf, 0.72),
    "--h4-ink": ink,
    "--h4-ink-2": dark ? mix(ink, muted, 0.16) : mix(ink, muted, 0.3),
    "--h4-muted": dark ? lighten(muted, 0.22) : muted,
    "--h4-faint": dark ? lighten(mix(muted, base, 0.28), 0.08) : mix(muted, base, 0.45),
    "--h4-line": rgba(ink, dark ? 0.14 : 0.12),
    "--h4-line-2": rgba(ink, dark ? 0.08 : 0.06),
    "--h4-line-strong": rgba(ink, dark ? 0.22 : 0.16),
    "--h4-act": accent,
    "--h4-act-deep": accFill,
    "--h4-act-ink": accInk,
    "--h4-act-text": dark ? lighten(accent, 0.1) : darken(accent, 0.12),
    "--h4-act-soft": rgba(accent, dark ? 0.18 : 0.12),
    "--h4-act-soft-2": rgba(accent, dark ? 0.3 : 0.2),
    "--h4-act-line": rgba(accent, dark ? 0.5 : 0.34),
    // DECIDE tier tint — desaturated toward neutral so it never blurs with the true coral CTA.
    "--h4-tier-decide-bg": rgba(mix(accent, base, dark ? 0.55 : 0.45), dark ? 0.16 : 0.34),
    "--h4-tier-decide-line": rgba(mix(accent, base, dark ? 0.4 : 0.32), dark ? 0.34 : 0.3),
    "--h4-tier-decide-text": dark ? lighten(mix(accent, muted, 0.34), 0.06) : darken(mix(accent, muted, 0.3), 0.04),
    "--h4-ok": ok,
    "--h4-ok-text": dark ? lighten(ok, 0.12) : darken(ok, 0.1),
    "--h4-ok-soft": rgba(ok, dark ? 0.2 : 0.16),
    "--h4-ok-line": rgba(ok, dark ? 0.42 : 0.24),
    "--h4-warn": warn,
    "--h4-warn-text": dark ? lighten(warn, 0.1) : darken(warn, 0.14),
    "--h4-warn-soft": rgba(warn, dark ? 0.2 : 0.16),
    "--h4-warn-line": rgba(warn, dark ? 0.42 : 0.28),
    "--h4-tel": dark ? lighten(muted, 0.18) : darken(muted, 0.04),
    "--h4-tel-soft": rgba(muted, dark ? 0.18 : 0.5),
    "--h4-tel-chip": dark ? mix(surf, muted, 0.2) : mix(base, muted, 0.16),
    "--h4-glow-1": rgba(accent, dark ? (glow ? 0.14 : 0.1) : 0.05),
    "--h4-glow-2": rgba(ok, dark ? 0.07 : 0.04),
    "--h4-act-glow": dark ? `0 0 ${glow ? 20 : 14}px ${rgba(accent, glow ? 0.6 : 0.45)}` : "none",
    "--h4-sh-sm": dark ? "0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.40)" : "0 1px 2px rgba(40,33,18,0.05), 0 2px 6px rgba(40,33,18,0.04)",
    "--h4-sh": dark ? "inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 30px rgba(0,0,0,0.45)" : "0 2px 6px rgba(40,33,18,0.05), 0 14px 34px rgba(40,33,18,0.07)",
    "--h4-sh-lift": dark ? "inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 44px rgba(0,0,0,0.55)" : "0 8px 18px rgba(40,33,18,0.09), 0 26px 56px rgba(40,33,18,0.12)",
    "--h4-sh-coral": dark ? `0 6px 22px ${rgba(accent, glow ? 0.55 : 0.4)}, 0 0 ${glow ? 22 : 14}px ${rgba(accent, glow ? 0.5 : 0.32)}` : `0 8px 24px ${rgba(accent, 0.24)}`,
    "--h4-sh-inset": dark ? "inset 0 1px 0 rgba(255,255,255,0.10)" : "inset 0 1px 0 rgba(255,255,255,0.6)",
  };
}

function resolveProfile(id: ColorProfileId): ColorProfile {
  return PROFILES[id] ?? PROFILES[DEFAULT_PROFILE];
}

/**
 * Apply a color profile to a root element (default <html>): writes the
 * `--h4-*` custom properties and sets the `data-h4-profile/dark/glow`
 * attributes the scoped CSS keys on. Returns the resolved id.
 */
export function applyColorProfile(id: ColorProfileId, root: HTMLElement = document.documentElement): ColorProfileId {
  const resolvedId = PROFILES[id] ? id : DEFAULT_PROFILE;
  const p = resolveProfile(resolvedId);
  const vars = buildTheme(p);
  for (const key in vars) root.style.setProperty(key, vars[key]!);
  root.setAttribute("data-h4-profile", resolvedId);
  root.setAttribute("data-h4-dark", p.dark ? "1" : "0");
  root.setAttribute("data-h4-glow", p.glow ? "1" : "0");
  return resolvedId;
}

/** True when the environment asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Apply motion intensity: writes `--h4-mi` (0..1) and `data-h4-motion` bucket.
 * prefers-reduced-motion forces the bucket to "off" so JS-gated motion stops
 * too (the CSS @media already disables animations).
 */
export function applyMotion(intensity: number, root: HTMLElement = document.documentElement): MotionBucket {
  const clamped = Math.max(0, Math.min(100, intensity));
  const bucket = prefersReducedMotion() ? "off" : motionBucket(clamped);
  root.style.setProperty("--h4-mi", String(Math.max(clamped / 100, 0)));
  root.setAttribute("data-h4-motion", bucket);
  return bucket;
}

/** Apply density bucket: sets `data-h4-density` (the CSS scopes spacing on it). */
export function applyDensity(density: Density, root: HTMLElement = document.documentElement): Density {
  const value: Density = density === "compact" || density === "comfy" ? density : "regular";
  root.setAttribute("data-h4-density", value);
  return value;
}

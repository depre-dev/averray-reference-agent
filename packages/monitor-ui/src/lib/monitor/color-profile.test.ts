// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import {
  PROFILES,
  PROFILE_OPTIONS,
  DEFAULT_PROFILE,
  buildTheme,
  mix,
  darken,
  lighten,
  rgba,
  inkOn,
  motionBucket,
  applyColorProfile,
  applyMotion,
  applyDensity,
} from "./color-profile.js";

afterEach(() => {
  const root = document.documentElement;
  for (const attr of ["data-h4-profile", "data-h4-dark", "data-h4-glow", "data-h4-motion", "data-h4-density"]) {
    root.removeAttribute(attr);
  }
  root.removeAttribute("style");
});

describe("color math (verbatim port)", () => {
  test("mix / lighten / darken / rgba / inkOn", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(lighten("#000000", 1)).toBe("#ffffff");
    expect(darken("#ffffff", 1)).toBe("#000000");
    expect(rgba("#E8865E", 0.18)).toBe("rgba(232,134,94,0.18)");
    expect(inkOn("#ffffff")).toBe("#14110c"); // light bg → dark ink
    expect(inkOn("#1A1714")).toBe("#ffffff"); // dark bg → light ink
  });
});

describe("profiles", () => {
  test("ships all 6 profiles; default is Midnight", () => {
    expect(Object.keys(PROFILES).sort()).toEqual(["averray", "claude", "editorial", "midnight", "midpolka", "slate"]);
    expect(PROFILE_OPTIONS).toHaveLength(6);
    expect(DEFAULT_PROFILE).toBe("midnight");
    expect(PROFILES.midnight.dark).toBe(true);
    expect(PROFILES.claude.dark).toBe(false);
  });

  test("buildTheme emits a full --h4-* token set keyed off the profile", () => {
    const theme = buildTheme(PROFILES.midnight);
    expect(theme["--h4-canvas"]).toBe("#1A1714");
    expect(theme["--h4-paper"]).toBe("#241F1B");
    expect(theme["--h4-ink"]).toBe("#EDE6DD");
    expect(theme["--h4-act"]).toBe("#E8865E");
    // accent ink is computed from luminance: the coral sits below the 0.42
    // threshold, so inkOn picks white.
    expect(theme["--h4-act-ink"]).toBe("#ffffff");
    expect(theme["--h4-ok"]).toBe("#7FB089");
    expect(theme["--h4-warn"]).toBe("#E0A050");
    expect(theme["--h4-tier-decide-bg"]).toMatch(/^rgba\(/);
    // every key is namespaced --h4-* (no clobber of --hm-*/--avy-*).
    expect(Object.keys(theme).every((k) => k.startsWith("--h4-"))).toBe(true);
  });

  test("Averray profile honors its explicit accentFill / accentInk overrides", () => {
    const theme = buildTheme(PROFILES.averray);
    expect(theme["--h4-act"]).toBe("#E6007A");
    expect(theme["--h4-act-deep"]).toBe("#D6006E");
    expect(theme["--h4-act-ink"]).toBe("#ffffff");
  });
});

describe("motion buckets", () => {
  test("slider value → bucket", () => {
    expect(motionBucket(0)).toBe("off");
    expect(motionBucket(20)).toBe("low");
    expect(motionBucket(60)).toBe("med");
    expect(motionBucket(90)).toBe("high");
  });
});

describe("apply* write to <html>", () => {
  test("applyColorProfile sets --h4-* props + data-h4-profile/dark/glow", () => {
    const root = document.documentElement;
    const id = applyColorProfile("midpolka", root);
    expect(id).toBe("midpolka");
    expect(root.getAttribute("data-h4-profile")).toBe("midpolka");
    expect(root.getAttribute("data-h4-dark")).toBe("1");
    expect(root.getAttribute("data-h4-glow")).toBe("1");
    expect(root.style.getPropertyValue("--h4-act")).toBe("#FF2D92");
    // it never writes a shipped-board token.
    expect(root.style.getPropertyValue("--hm-paper")).toBe("");
    expect(root.style.getPropertyValue("--avy-ink")).toBe("");
  });

  test("an unknown profile falls back to the default", () => {
    const id = applyColorProfile("nope" as never, document.documentElement);
    expect(id).toBe(DEFAULT_PROFILE);
  });

  test("applyMotion sets --h4-mi + data-h4-motion; applyDensity sets data-h4-density", () => {
    const root = document.documentElement;
    applyMotion(60, root);
    expect(root.getAttribute("data-h4-motion")).toBe("med");
    expect(root.style.getPropertyValue("--h4-mi")).toBe("0.6");
    applyDensity("compact", root);
    expect(root.getAttribute("data-h4-density")).toBe("compact");
    applyDensity("bogus" as never, root);
    expect(root.getAttribute("data-h4-density")).toBe("regular");
  });
});

// Hermes-4 theme hook (PR-D1).
//
// Applies the active color profile + motion intensity + density to <html> as
// `--h4-*` custom properties and `data-h4-*` attributes. Mounts the D1 default
// (Midnight) and re-applies motion when the prefers-reduced-motion preference
// changes. A profile switcher UI (the tweaks panel) lands in a later D-PR; this
// hook already exposes the setters it will drive.

import { useCallback, useEffect, useState } from "react";
import {
  applyColorProfile,
  applyDensity,
  applyMotion,
  DEFAULT_DENSITY,
  DEFAULT_MOTION,
  DEFAULT_PROFILE,
  type ColorProfileId,
  type Density,
} from "../lib/monitor/color-profile.js";

export interface UseColorProfileOptions {
  profile?: ColorProfileId;
  motion?: number;
  density?: Density;
}

export interface ColorProfileControls {
  profile: ColorProfileId;
  setProfile: (profile: ColorProfileId) => void;
  motion: number;
  setMotion: (motion: number) => void;
  density: Density;
  setDensity: (density: Density) => void;
}

export function useColorProfile(opts: UseColorProfileOptions = {}): ColorProfileControls {
  const [profile, setProfile] = useState<ColorProfileId>(opts.profile ?? DEFAULT_PROFILE);
  const [motion, setMotion] = useState<number>(opts.motion ?? DEFAULT_MOTION);
  const [density, setDensity] = useState<Density>(opts.density ?? DEFAULT_DENSITY);

  useEffect(() => {
    applyColorProfile(profile);
  }, [profile]);

  useEffect(() => {
    applyMotion(motion);
  }, [motion]);

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  // Honor prefers-reduced-motion changes after mount (applyMotion forces the
  // bucket to "off" when reduced).
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => applyMotion(motion);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [motion]);

  return {
    profile,
    setProfile: useCallback((p: ColorProfileId) => setProfile(p), []),
    motion,
    setMotion: useCallback((m: number) => setMotion(m), []),
    density,
    setDensity: useCallback((d: Density) => setDensity(d), []),
  };
}

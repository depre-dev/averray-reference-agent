// O4-PR3a — autonomy mode hook for the board container.
//
// Reads the current mode from GET /monitor/autonomy-mode on mount and exposes
// setAutopilot/setSupervised that POST the change. Best-effort + optimistic:
// the board toggle reflects the operator's click immediately; the server is the
// source of truth (and re-caps any window) on the next read. Network/fetch is
// guarded so this is inert in tests that don't wire it.

import { useCallback, useEffect, useState } from "react";

export type AutonomyMode = "supervised" | "autopilot";

const AUTONOMY_URL = "/monitor/autonomy-mode";

export interface UseAutonomyModeOptions {
  /** Override the network for tests. Return the current mode, or null to skip. */
  fetchMode?: () => Promise<AutonomyMode | null>;
  /** Override the setter for tests. */
  postMode?: (body: { mode: AutonomyMode; untilMs?: number }) => Promise<AutonomyMode | null>;
}

export interface UseAutonomyMode {
  mode: AutonomyMode;
  setAutopilot: (untilMs?: number) => void;
  setSupervised: () => void;
}

function canFetch(): boolean {
  return typeof fetch === "function";
}

async function defaultFetchMode(): Promise<AutonomyMode | null> {
  if (!canFetch()) return null;
  try {
    const res = await fetch(AUTONOMY_URL, { method: "GET" });
    if (!res.ok) return null;
    const json = (await res.json()) as { autonomy?: { mode?: string } };
    return json.autonomy?.mode === "autopilot" ? "autopilot" : "supervised";
  } catch {
    return null;
  }
}

async function defaultPostMode(body: { mode: AutonomyMode; untilMs?: number }): Promise<AutonomyMode | null> {
  if (!canFetch()) return null;
  try {
    const res = await fetch(AUTONOMY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { autonomy?: { mode?: string } };
    return json.autonomy?.mode === "autopilot" ? "autopilot" : "supervised";
  } catch {
    return null;
  }
}

export function useAutonomyMode(options: UseAutonomyModeOptions = {}): UseAutonomyMode {
  const fetchMode = options.fetchMode ?? defaultFetchMode;
  const postMode = options.postMode ?? defaultPostMode;
  const [mode, setMode] = useState<AutonomyMode>("supervised");

  useEffect(() => {
    let active = true;
    void fetchMode().then((m) => {
      if (active && m) setMode(m);
    });
    return () => {
      active = false;
    };
    // fetchMode is stable for the lifetime of the page (default or test override).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAutopilot = useCallback(
    (untilMs?: number) => {
      setMode("autopilot"); // optimistic
      void postMode({ mode: "autopilot", ...(untilMs !== undefined ? { untilMs } : {}) }).then((m) => {
        if (m) setMode(m);
      });
    },
    [postMode],
  );

  const setSupervised = useCallback(() => {
    setMode("supervised"); // optimistic
    void postMode({ mode: "supervised" }).then((m) => {
      if (m) setMode(m);
    });
  }, [postMode]);

  return { mode, setAutopilot, setSupervised };
}

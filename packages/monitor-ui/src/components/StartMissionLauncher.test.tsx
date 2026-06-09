// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { StartMissionLauncher } from "./StartMissionLauncher.js";

afterEach(cleanup);

// The launcher is always-expanded now (no "Start a mission" toggle): the form
// is present the moment it renders.
function selectFlow(r: RenderResult, label: string) {
  const radio = r.getByText(label).closest("label")?.querySelector("input");
  fireEvent.click(radio as HTMLInputElement);
}

// The submit button's label states the consequence — "Propose mission" (the
// safe default) or "Launch mission" (when approval is turned off).
function submit(r: RenderResult) {
  fireEvent.click(r.getByRole("button", { name: /Propose mission|Launch mission/ }));
}

function toggleApproval(r: RenderResult) {
  fireEvent.click(r.getByLabelText(/Request approval/));
}

describe("StartMissionLauncher — Citation Repair flow", () => {
  test("selecting Citation Repair swaps Target URL for a read-only Job ID field", () => {
    const r = render(<StartMissionLauncher onSpawnMission={() => {}} />);
    selectFlow(r, "Citation Repair");

    expect(r.getByLabelText(/Job ID/)).toBeTruthy();
    expect(r.queryByText("Target")).toBeNull(); // URL field is swapped out
    expect(r.getByText(/read-only analysis/i)).toBeTruthy();
  });

  test("proposing Citation Repair with a Job ID spawns { mode: citation_repair, jobId } and no target", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    selectFlow(r, "Citation Repair");
    fireEvent.change(r.getByLabelText(/Job ID/), { target: { value: "wiki-en-62871101" } });
    submit(r);

    expect(onSpawnMission).toHaveBeenCalledTimes(1);
    // Propose-by-default → initialStatus "requested".
    expect(onSpawnMission).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "citation_repair", jobId: "wiki-en-62871101", targetUrl: "", initialStatus: "requested" })
    );
  });

  test("Citation Repair with an empty Job ID still launches (workflow auto-selects)", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    selectFlow(r, "Citation Repair");
    submit(r);

    expect(onSpawnMission).toHaveBeenCalledTimes(1);
    const arg = onSpawnMission.mock.calls[0]![0];
    expect(arg.mode).toBe("citation_repair");
    expect(arg).not.toHaveProperty("jobId");
  });

  test("does not regress: Surface Sweep still launches with a targetUrl and no jobId", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    submit(r); // surface_sweep is the default flow

    expect(onSpawnMission).toHaveBeenCalledTimes(1);
    const arg = onSpawnMission.mock.calls[0]![0];
    expect(arg.mode).toBe("surface_sweep");
    expect(arg.targetUrl).toMatch(/^https?:\/\//);
    expect(arg.initialStatus).toBe("requested"); // propose by default
    expect(arg).not.toHaveProperty("jobId");
  });
});

describe("StartMissionLauncher — intuitive flow picker + consequence CTA", () => {
  test("shows a plain-language description for the selected flow", () => {
    const r = render(<StartMissionLauncher onSpawnMission={() => {}} />);
    // Default flow's description is visible up front.
    expect(r.getByText(/Read-only crawl/)).toBeTruthy();
    selectFlow(r, "Gold Path");
    expect(r.getByText(/end-to-end/)).toBeTruthy();
    selectFlow(r, "Role Gating");
    expect(r.getByText(/access controls/)).toBeTruthy();
  });

  test("CTA states the consequence: Propose by default, Launch when approval is off", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    // Default: propose (safe — goes to Your decisions).
    expect(r.getByRole("button", { name: "Propose mission" })).toBeTruthy();
    expect(r.getByText(/lands in Your decisions/)).toBeTruthy();

    // Turn approval off → auto-dispatch.
    toggleApproval(r);
    expect(r.getByRole("button", { name: "Launch mission" })).toBeTruthy();
    expect(r.getByText(/Auto-dispatch/)).toBeTruthy();

    submit(r);
    expect(onSpawnMission).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "surface_sweep", initialStatus: "ready" })
    );
  });
});

describe("StartMissionLauncher — launch feedback (no more silent close)", () => {
  test("a reported success shows 'Mission requested ✓' and keeps the panel open", async () => {
    const onSpawnMission = vi.fn(async () => ({ ok: true, status: 200 }));
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    submit(r);

    expect(await r.findByText(/Mission requested ✓/)).toBeTruthy();
    // The panel stays put (the silent close was the "nothing happens" report).
    expect(r.getByText("Target")).toBeTruthy();
  });

  test("a non-2xx POST shows an explicit failure instead of failing silently", async () => {
    const onSpawnMission = vi.fn(async () => ({ ok: false, status: 500 }));
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    submit(r);

    const alert = await r.findByRole("alert");
    expect(alert.textContent).toMatch(/Launch failed — HTTP 500/);
    expect(r.getByText("Target")).toBeTruthy(); // still open so the operator can retry
  });

  test("a network failure ({ ok:false, error }) reads as a failure, not success", async () => {
    const onSpawnMission = vi.fn(async () => ({ ok: false, error: "network" }));
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    submit(r);

    const alert = await r.findByRole("alert");
    expect(alert.textContent).toMatch(/Launch failed — network/);
  });

  test("a fire-and-forget handler (returns void) still confirms best-effort", () => {
    const onSpawnMission = vi.fn(() => {});
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    submit(r);

    expect(r.getByText(/Mission requested ✓/)).toBeTruthy(); // synchronous, no await
  });
});

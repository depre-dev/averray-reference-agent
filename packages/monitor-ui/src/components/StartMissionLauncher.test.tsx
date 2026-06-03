// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { StartMissionLauncher } from "./StartMissionLauncher.js";

afterEach(cleanup);

function openLauncher(r: RenderResult) {
  fireEvent.click(r.getByRole("button", { name: "Start a mission" }));
}

function selectFlow(r: RenderResult, label: string) {
  const radio = r.getByText(label).closest("label")?.querySelector("input");
  fireEvent.click(radio as HTMLInputElement);
}

function launch(r: RenderResult) {
  fireEvent.click(r.getByRole("button", { name: "Launch mission" }));
}

describe("StartMissionLauncher — Citation Repair flow", () => {
  test("selecting Citation Repair swaps Target URL for a read-only Job ID field", () => {
    const r = render(<StartMissionLauncher onSpawnMission={() => {}} />);
    openLauncher(r);
    selectFlow(r, "Citation Repair");

    expect(r.getByLabelText(/Job ID/)).toBeTruthy();
    expect(r.queryByText("Target")).toBeNull(); // URL field is swapped out
    expect(r.getByText(/read-only analysis/i)).toBeTruthy();
  });

  test("launching Citation Repair with a Job ID spawns { mode: citation_repair, jobId } and no target", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    openLauncher(r);
    selectFlow(r, "Citation Repair");
    fireEvent.change(r.getByLabelText(/Job ID/), { target: { value: "wiki-en-62871101" } });
    launch(r);

    expect(onSpawnMission).toHaveBeenCalledTimes(1);
    expect(onSpawnMission).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "citation_repair", jobId: "wiki-en-62871101", targetUrl: "", initialStatus: "ready" })
    );
  });

  test("Citation Repair with an empty Job ID still launches (workflow auto-selects)", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    openLauncher(r);
    selectFlow(r, "Citation Repair");
    launch(r);

    expect(onSpawnMission).toHaveBeenCalledTimes(1);
    const arg = onSpawnMission.mock.calls[0]![0];
    expect(arg.mode).toBe("citation_repair");
    expect(arg).not.toHaveProperty("jobId");
  });

  test("does not regress: Surface Sweep still launches with a targetUrl and no jobId", () => {
    const onSpawnMission = vi.fn();
    const r = render(<StartMissionLauncher onSpawnMission={onSpawnMission} />);
    openLauncher(r);
    launch(r); // surface_sweep is the default flow

    expect(onSpawnMission).toHaveBeenCalledTimes(1);
    const arg = onSpawnMission.mock.calls[0]![0];
    expect(arg.mode).toBe("surface_sweep");
    expect(arg.targetUrl).toMatch(/^https?:\/\//);
    expect(arg).not.toHaveProperty("jobId");
  });
});

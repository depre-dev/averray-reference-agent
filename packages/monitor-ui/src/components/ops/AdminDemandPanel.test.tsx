// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { AdminDemandFeed } from "../../lib/monitor/admin-demand.js";
import { AdminDemandPanel } from "./AdminDemandPanel.js";

afterEach(cleanup);

const TESTER_WALLET = "0xDeD3D610546DF151a6BB3D6ed119c3700ABC2146";

function feed(): AdminDemandFeed {
  const collectionSince = "2026-08-21T08:00:00.000Z";
  return {
    schemaVersion: "averray.monitor.arrivals-journeys.v1",
    generatedAt: "2026-08-22T10:00:00.000Z",
    collectionSince,
    window: "48h",
    timeline: {
      schemaVersion: "averray.admin.arrivals.timeline.v1",
      generatedAt: "2026-08-22T10:00:00.000Z",
      collectionSince,
      window: {
        id: "48h",
        bucket: "hour",
        start: "2026-08-21T10:00:00.000Z",
        end: "2026-08-22T10:00:00.000Z",
        bucketCount: 48,
        retentionDays: 30,
        backfilled: false,
      },
      dimensions: {
        surfaces: ["manifest", "onboarding", "jobs_reads", "mcp_initialize", "verify_profiles"],
        clientSoftwareClasses: ["claude", "cursor", "codex", "browser", "mcp_bridge", "directory", "other_declared", "unidentified"],
      },
      buckets: [
        {
          start: "2026-08-22T08:00:00.000Z",
          end: "2026-08-22T09:00:00.000Z",
          total: 4,
          counts: [
            { surface: "manifest", clientClass: "claude", count: 2 },
            { surface: "manifest", clientClass: "cursor", count: 1 },
            { surface: "jobs_reads", clientClass: "browser", count: 1 },
          ],
        },
        {
          start: "2026-08-22T09:00:00.000Z",
          end: "2026-08-22T10:00:00.000Z",
          total: 2,
          counts: [
            { surface: "onboarding", clientClass: "unidentified", count: 1 },
            { surface: "mcp_initialize", clientClass: "mcp_bridge", count: 1 },
          ],
        },
      ],
    },
    journeys: {
      schemaVersion: "averray.admin.worker-journeys.v1",
      generatedAt: "2026-08-22T10:00:00.000Z",
      collectionSince,
      window: {
        id: "recent_active",
        backfilled: false,
        sessionReadCap: 500,
        eventReadCap: 2_000,
        journeyEventPerWalletCap: 250,
      },
      scope: "operator",
      identityBoundary: "identity begins at SIWE",
      count: 1,
      limit: 50,
      journeys: [
        {
          wallet: TESTER_WALLET,
          classification: "external",
          classificationAuthority: "shared_self_identity_registry",
          firstSeenAt: "2026-08-22T08:00:00.000Z",
          lastActiveAt: "2026-08-22T08:29:00.000Z",
          events: [
            event("first_seen", "2026-08-22T08:00:00.000Z", "arrival_events"),
            event("signed_in", "2026-08-22T08:01:00.000Z", "journey_events", 60_000),
            event("preflighted", "2026-08-22T08:03:00.000Z", "journey_events", 120_000),
            event("claimed", "2026-08-22T08:04:00.000Z", "claim_sessions", 60_000),
            event("submitted", "2026-08-22T08:20:00.000Z", "claim_sessions", 960_000),
            event("verified", "2026-08-22T08:25:00.000Z", "verification_events", 300_000),
            { ...event("settled", "2026-08-22T08:27:00.000Z", "settlement_events", 120_000), txHash: "0x1234567890abcdef1234567890abcdef" },
            event("withdrawal_intent", "2026-08-22T08:29:00.000Z", "journey_events", 120_000),
          ],
        },
      ],
    },
  };
}

function event(type: "first_seen" | "signed_in" | "preflighted" | "claimed" | "submitted" | "verified" | "settled" | "withdrawal_intent", timestamp: string, sourceStore: string, durationFromPreviousMs?: number) {
  return {
    id: `${type}:${timestamp}`,
    type,
    timestamp,
    sourceStore,
    ...(durationFromPreviousMs === undefined ? {} : { durationFromPreviousMs }),
  };
}

describe("AdminDemandPanel", () => {
  it("renders every arrival surface as a client-class-stacked timeline", () => {
    const { getByTestId, container } = render(
      <AdminDemandPanel feed={feed()} window="48h" onWindowChange={() => undefined} />,
    );
    for (const surface of ["manifest", "onboarding", "jobs_reads", "mcp_initialize", "verify_profiles"]) {
      expect(getByTestId(`ops-demand-surface-${surface}`)).toBeTruthy();
    }
    expect(container.querySelectorAll('.ops-demand-bar-stack > [data-client="claude"]')).toHaveLength(1);
    expect(container.querySelectorAll('.ops-demand-bar-stack > [data-client="cursor"]')).toHaveLength(1);
    expect(getByTestId("ops-demand-timeline").textContent).toContain("aggregate only");
  });

  it("switches between the ratified hourly and daily windows without an operational action", () => {
    const onWindowChange = vi.fn();
    const { getByLabelText } = render(
      <AdminDemandPanel feed={feed()} window="48h" onWindowChange={onWindowChange} />,
    );
    fireEvent.change(getByLabelText("Arrivals timeline window"), { target: { value: "30d" } });
    expect(onWindowChange).toHaveBeenCalledWith("30d");
  });

  it("renders the blind tester wallet as a complete expandable journey with durations and provenance", () => {
    const { getByTestId, getByText } = render(
      <AdminDemandPanel feed={feed()} window="48h" onWindowChange={() => undefined} />,
    );
    const journey = getByTestId(`ops-demand-journey-${TESTER_WALLET}`);
    expect(journey.getAttribute("data-classification")).toBe("external");
    fireEvent.click(journey.querySelector("summary")!);
    for (const stage of ["arrived", "signed in", "preflighted", "claimed", "submitted", "verified", "settled", "withdrawal intent"]) {
      expect(getByText(stage)).toBeTruthy();
    }
    expect(journey.textContent).toContain("+16m");
    expect(journey.textContent).toContain("claim_sessions");
    expect(journey.textContent).toContain("tx 0x12345678");
  });

  it("states the collection cut-over and never implies a backfill", () => {
    const { getByTestId } = render(
      <AdminDemandPanel feed={feed()} window="48h" onWindowChange={() => undefined} />,
    );
    expect(getByTestId("ops-demand-cutover").textContent).toContain("data begins");
    expect(getByTestId("ops-demand-cutover").textContent).toContain("no backfill");
  });

  it("renders failed reads as unavailable rather than empty zeroes", () => {
    const unavailable: AdminDemandFeed = {
      schemaVersion: "averray.monitor.arrivals-journeys.v1",
      generatedAt: "2026-08-22T10:00:00.000Z",
      window: "48h",
      timeline: { unavailable: "admin role refused" },
      journeys: { unavailable: "admin role refused" },
    };
    const { getByTestId, queryByTestId } = render(
      <AdminDemandPanel feed={unavailable} window="48h" onWindowChange={() => undefined} />,
    );
    expect(getByTestId("ops-demand-timeline-unavailable").textContent).toContain("admin role refused");
    expect(getByTestId("ops-demand-journeys-unavailable").textContent).toContain("admin role refused");
    expect(queryByTestId("ops-demand-surface-manifest")).toBeNull();
  });
});

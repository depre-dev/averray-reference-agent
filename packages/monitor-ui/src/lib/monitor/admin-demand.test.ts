import { describe, expect, it } from "vitest";

import { parseAdminDemandFeed } from "./admin-demand.js";

function payload() {
  const collectionSince = "2026-08-22T10:00:00.000Z";
  return {
    schemaVersion: "averray.monitor.arrivals-journeys.v1",
    generatedAt: "2026-08-22T11:00:00.000Z",
    collectionSince,
    window: "48h",
    timeline: {
      schemaVersion: "averray.admin.arrivals.timeline.v1",
      generatedAt: "2026-08-22T11:00:00.000Z",
      collectionSince,
      window: {
        id: "48h",
        bucket: "hour",
        start: "2026-08-20T11:00:00.000Z",
        end: "2026-08-22T11:00:00.000Z",
        bucketCount: 48,
        retentionDays: 30,
        backfilled: false,
      },
      dimensions: {
        surfaces: ["manifest", "onboarding", "jobs_reads", "mcp_initialize", "verify_profiles"],
        clientSoftwareClasses: ["claude", "cursor", "codex", "browser", "mcp_bridge", "directory", "other_declared", "unidentified"],
      },
      buckets: [{
        start: "2026-08-22T10:00:00.000Z",
        end: "2026-08-22T11:00:00.000Z",
        total: 1,
        counts: [{ surface: "manifest", clientClass: "browser", count: 1 }],
      }],
    },
    journeys: {
      schemaVersion: "averray.admin.worker-journeys.v1",
      generatedAt: "2026-08-22T11:00:00.000Z",
      collectionSince,
      window: {
        id: "recent_active",
        backfilled: false,
        sessionReadCap: 250,
        eventReadCap: 500,
        journeyEventPerWalletCap: 250,
      },
      scope: "operator",
      identityBoundary: "Wallet identity begins at successful SIWE.",
      count: 1,
      limit: 50,
      journeys: [{
        wallet: "0xded3d610546df151a6bb3d6ed119c3700abc2146",
        classification: "external",
        classificationAuthority: "shared_self_identity_registry",
        firstSeenAt: "2026-08-22T10:30:00.000Z",
        lastActiveAt: "2026-08-22T10:30:00.000Z",
        events: [{
          id: "first-seen",
          type: "first_seen",
          timestamp: "2026-08-22T10:30:00.000Z",
          sourceStore: "event-log",
          durationFromPreviousMs: null,
        }],
      }],
    },
  };
}

describe("admin demand response parser", () => {
  it("accepts the Part A first-event null duration without inventing elapsed time", () => {
    const parsed = parseAdminDemandFeed(payload());
    expect("unavailable" in parsed.journeys).toBe(false);
    if ("unavailable" in parsed.journeys) throw new Error("unexpected unavailable fixture");
    expect(parsed.journeys.journeys[0]?.events[0]?.durationFromPreviousMs).toBeNull();
  });

  it("rejects a client class outside the fixed aggregate taxonomy", () => {
    const value = payload();
    value.timeline.buckets[0]!.counts[0]!.clientClass = "raw-user-agent";
    expect(() => parseAdminDemandFeed(value)).toThrow(/timeline count/u);
  });

  it("rejects a journey response that does not state operator scope", () => {
    const value = payload();
    value.journeys.scope = "public";
    expect(() => parseAdminDemandFeed(value)).toThrow(/operator scope/u);
  });
});

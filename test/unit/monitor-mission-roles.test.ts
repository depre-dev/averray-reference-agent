import { describe, expect, it } from "vitest";

import {
  authorizeMissionSpawn,
  missionSpawnIdentity,
  missionSpawnRestricted,
  parseMissionSpawnRoles,
  type MissionSpawnRoles,
} from "../../services/slack-operator/src/monitor-mission-roles.js";

const ADMIN_ENV = "SLACK_OPERATOR_MONITOR_ADMIN_EMAILS";
const OPERATOR_ENV = "SLACK_OPERATOR_MONITOR_MISSION_OPERATOR_EMAILS";

function header(email?: string): Record<string, string | string[] | undefined> {
  return email ? { "cf-access-authenticated-user-email": email } : {};
}

describe("parseMissionSpawnRoles", () => {
  it("returns empty allowlists when unset", () => {
    expect(parseMissionSpawnRoles({})).toEqual({ admins: [], operators: [] });
  });

  it("splits on commas / semicolons / whitespace, lower-cases, trims, and dedupes", () => {
    const roles = parseMissionSpawnRoles({
      [ADMIN_ENV]: "Alice@averray.com, alice@averray.com ; BOB@averray.com",
      [OPERATOR_ENV]: "carol@averray.com\n dave@averray.com",
    });
    expect(roles.admins).toEqual(["alice@averray.com", "bob@averray.com"]);
    expect(roles.operators).toEqual(["carol@averray.com", "dave@averray.com"]);
  });
});

describe("missionSpawnRestricted", () => {
  it("is false only when both allowlists are empty", () => {
    expect(missionSpawnRestricted({ admins: [], operators: [] })).toBe(false);
    expect(missionSpawnRestricted({ admins: ["a@x.com"], operators: [] })).toBe(true);
    expect(missionSpawnRestricted({ admins: [], operators: ["o@x.com"] })).toBe(true);
  });
});

describe("missionSpawnIdentity", () => {
  it("reads and lower-cases the Cloudflare Access email header", () => {
    expect(missionSpawnIdentity(header("Alice@Averray.com"))).toBe("alice@averray.com");
  });
  it("handles array-valued headers and absence", () => {
    expect(missionSpawnIdentity({ "cf-access-authenticated-user-email": ["x@y.com"] })).toBe("x@y.com");
    expect(missionSpawnIdentity({})).toBeUndefined();
    expect(missionSpawnIdentity({ "cf-access-authenticated-user-email": "   " })).toBeUndefined();
  });
});

describe("authorizeMissionSpawn", () => {
  const restricted: MissionSpawnRoles = { admins: ["admin@averray.com"], operators: ["op@averray.com"] };

  it("allows everyone when no allowlists are configured (opt-in gate)", () => {
    const verdict = authorizeMissionSpawn({ admins: [], operators: [] }, header());
    expect(verdict).toEqual({ allowed: true, reason: "unrestricted" });
  });

  it("allows an admin", () => {
    expect(authorizeMissionSpawn(restricted, header("admin@averray.com"))).toEqual({
      allowed: true,
      reason: "admin",
      identity: "admin@averray.com",
    });
  });

  it("allows a mission-operator", () => {
    expect(authorizeMissionSpawn(restricted, header("op@averray.com"))).toEqual({
      allowed: true,
      reason: "mission-operator",
      identity: "op@averray.com",
    });
  });

  it("is case-insensitive on the identity", () => {
    expect(authorizeMissionSpawn(restricted, header("ADMIN@averray.com")).allowed).toBe(true);
  });

  it("denies an authenticated identity that holds no role", () => {
    expect(authorizeMissionSpawn(restricted, header("stranger@averray.com"))).toEqual({
      allowed: false,
      reason: "role_required",
      identity: "stranger@averray.com",
    });
  });

  it("denies when restricted but no identity header is present", () => {
    expect(authorizeMissionSpawn(restricted, header())).toEqual({ allowed: false, reason: "no_identity" });
  });
});

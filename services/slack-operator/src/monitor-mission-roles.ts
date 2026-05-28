// Hermes Handoff Monitor — mission-spawn role gate (§21.5).
//
// Spawning a browser mission (POST /monitor/testbed-missions) actuates a
// real Playwright agent against a live URL, so it is gated to an admin or
// a dedicated "mission-operator" role — over and above the Cloudflare
// Access edge gate + optional bearer token that already protect every
// /monitor route.
//
// Identity comes from the `Cf-Access-Authenticated-User-Email` header
// that Cloudflare Access injects after authenticating the request. The
// gate is OPT-IN: with no allowlists configured it is a no-op (the
// endpoint behaves exactly as before), matching the token convention in
// monitor.ts where an unset token means "no extra gate." Configure
// either allowlist to switch enforcement on.
//
// Trust model: this matches the existing posture — the origin trusts
// headers set by Cloudflare Access and must not be directly reachable.
// Verifying the `Cf-Access-Jwt-Assertion` signature against Cloudflare's
// JWKS would be strictly stronger defense-in-depth; that is a deliberate
// future hardening, noted here so the boundary is explicit.

const ADMIN_ENV = "SLACK_OPERATOR_MONITOR_ADMIN_EMAILS";
const OPERATOR_ENV = "SLACK_OPERATOR_MONITOR_MISSION_OPERATOR_EMAILS";
const IDENTITY_HEADER = "cf-access-authenticated-user-email";

export interface MissionSpawnRoles {
  /** Lower-cased admin emails allowed to spawn missions. */
  admins: string[];
  /** Lower-cased mission-operator emails allowed to spawn missions. */
  operators: string[];
}

export type MissionSpawnReason = "unrestricted" | "admin" | "mission-operator" | "no_identity" | "role_required";

export interface MissionSpawnVerdict {
  allowed: boolean;
  reason: MissionSpawnReason;
  identity?: string;
}

/** Parse the admin / mission-operator allowlists from the environment. */
export function parseMissionSpawnRoles(env: NodeJS.ProcessEnv): MissionSpawnRoles {
  return {
    admins: parseEmailList(env[ADMIN_ENV]),
    operators: parseEmailList(env[OPERATOR_ENV]),
  };
}

/** True once either allowlist is non-empty — i.e. the gate is enforcing. */
export function missionSpawnRestricted(roles: MissionSpawnRoles): boolean {
  return roles.admins.length > 0 || roles.operators.length > 0;
}

/** The Cloudflare-Access identity on a request, lower-cased, or undefined. */
export function missionSpawnIdentity(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers[IDENTITY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Decide whether a request may spawn a mission.
 *   - no allowlists configured → allowed (unrestricted; legacy behaviour)
 *   - allowlists set but no identity header → denied (no_identity)
 *   - identity in admins → allowed (admin)
 *   - identity in operators → allowed (mission-operator)
 *   - otherwise → denied (role_required)
 */
export function authorizeMissionSpawn(
  roles: MissionSpawnRoles,
  headers: Record<string, string | string[] | undefined>,
): MissionSpawnVerdict {
  if (!missionSpawnRestricted(roles)) return { allowed: true, reason: "unrestricted" };

  const identity = missionSpawnIdentity(headers);
  if (!identity) return { allowed: false, reason: "no_identity" };
  if (roles.admins.includes(identity)) return { allowed: true, reason: "admin", identity };
  if (roles.operators.includes(identity)) return { allowed: true, reason: "mission-operator", identity };
  return { allowed: false, reason: "role_required", identity };
}

function parseEmailList(value: string | undefined): string[] {
  if (typeof value !== "string") return [];
  const seen = new Set<string>();
  for (const part of value.split(/[,;\s]+/)) {
    const email = part.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

import {
  preflightPullRequestPayload,
} from "../../services/harness-dispatcher/dist/pr-payload-sender.js";

/**
 * INT-3c preflight imports only the sender's read-only operation. The live
 * entry point loads this module only for the explicit `preflight` verb.
 */
export async function runInt3cPreflight(actuation, deps) {
  return preflightPullRequestPayload(actuation, deps);
}

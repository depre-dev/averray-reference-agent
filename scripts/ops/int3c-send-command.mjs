import {
  sendPullRequestPayload,
} from "../../services/harness-dispatcher/dist/pr-payload-sender.js";

/** The outward-facing operation is reachable only through the `send` verb. */
export async function runInt3cSend(actuation, deps) {
  return sendPullRequestPayload(actuation, deps);
}

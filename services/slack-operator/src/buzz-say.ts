// Hand-triggered Buzz publish — the first real test of the narration path.
//
//   docker compose … exec slack-operator \
//     node services/slack-operator/dist/buzz-say.js "hello from Hermes"
//
// WHY A SEPARATE ENTRY POINT rather than waiting for a real incident: every
// piece of this path has so far only been proven against a scripted fake relay.
// The credential, the owner attestation, the closed-relay membership check, the
// channel UUID, and TLS through the Cloudflare tunnel have never been exercised
// together. Discovering a problem in any of them for the first time DURING a
// money-path incident — when narration is the thing meant to tell you — is the
// worst possible moment.
//
// It runs INSIDE the container on purpose. The point is to test the deployed
// configuration, not a local approximation of it: same env, same credentials,
// same network path, same code. A script that passes on a laptop and fails in
// production has tested the wrong thing.

import { publishNarration, readBuzzConfig } from "./buzz-client.js";

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(" ").trim()
    || `Hermes checking in — narration path test at ${new Date().toISOString()}`;

  const result = readBuzzConfig();
  if (!result.config) {
    // Distinguish "not set up" from "set up wrong" — the same distinction the
    // heartbeat makes, for the same reason.
    console.error(result.problem ?? "Buzz is not configured (no BUZZ_* variables set)");
    process.exitCode = 1;
    return;
  }

  const { relayUrl, channelId } = result.config;
  console.log(`publishing to ${relayUrl} channel ${channelId}`);
  console.log(`  ${text}`);

  const publish = await publishNarration(result.config, text);
  if (publish.ok) {
    console.log(`\nOK — ${publish.detail} (event ${publish.eventId})`);
    console.log("Check the channel in Buzz. If it is not there, the relay accepted an event");
    console.log("addressed to a DIFFERENT channel — verify BUZZ_OPS_CHANNEL_ID.");
    return;
  }

  console.error(`\nFAILED [${publish.reason}] ${publish.detail}`);
  if (publish.reason === "auth-rejected") {
    console.error("\nThe relay refused the owner attestation. Likely causes, in order:");
    console.error("  · BUZZ_OWNER_AUTH_TAG was minted for a different agent key");
    console.error("  · the owner in the tag is no longer a relay member");
    console.error("  · BUZZ_ALLOW_NIP_OA_AUTH is not true on the relay");
  }
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

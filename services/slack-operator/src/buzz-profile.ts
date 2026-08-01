// Publish Hermes's Buzz profile, so narration is authored by a name rather than
// a pubkey.
//
//   docker compose … exec slack-operator \
//     node services/slack-operator/dist/buzz-profile.js
//
// WHY THIS EXISTS: the first real message landed authored by `775a0f0a…a1af`.
// Nostr clients show the pubkey when there is no kind-0 metadata for a key, and
// an alert read at 3am should say WHO is speaking. That is the whole change —
// the difference between a message that reads like a colleague and one that
// reads like a hash.
//
// Kind 0 is replaceable, so running this again supersedes rather than
// duplicates. Safe to re-run after editing the text below.
//
// The `about` line is deliberately literal about what this agent is and what it
// cannot do. Anyone who clicks the profile is asking "what is this thing and
// should I trust what it just told me" — the honest answer belongs there, not a
// tagline.

import { publishAgentProfile, readBuzzConfig } from "./buzz-client.js";

const PROFILE = {
  displayName: "Hermes",
  name: "hermes",
  about:
    "Averray ops monitor. Posts when product health crosses the red boundary "
    + "and when it recovers. Reads the money path; never moves money. "
    + "Authorized by the relay owner — see the auth tag on its events.",
};

async function main(): Promise<void> {
  const result = readBuzzConfig();
  if (!result.config) {
    console.error(result.problem ?? "Buzz is not configured (no BUZZ_* variables set)");
    process.exitCode = 1;
    return;
  }

  console.log(`publishing profile to ${result.config.relayUrl}`);
  console.log(`  display_name  ${PROFILE.displayName}`);
  console.log(`  name          ${PROFILE.name}`);
  console.log(`  about         ${PROFILE.about}`);

  const publish = await publishAgentProfile(result.config, PROFILE);
  if (publish.ok) {
    console.log(`\nOK — ${publish.detail} (event ${publish.eventId})`);
    console.log("Buzz may cache the old profile briefly; reopen the channel if the name looks stale.");
    return;
  }

  console.error(`\nFAILED [${publish.reason}] ${publish.detail}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

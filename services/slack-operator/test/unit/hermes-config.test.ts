// The Hermes config is a MOUNTED ARTEFACT, not code — nothing typechecks it,
// nothing imports it, and CI has no opinion about it. It is bind-mounted into
// the gateway at /opt/data/config.yaml and read once at boot, so a wrong value
// here surfaces as a live control-plane outage and nowhere earlier.
//
// That is exactly what happened on 2026-08-04. Every question asked in Buzz
// #Ops failed for six hours with `model "hermes-agent" not found` while the
// gateway, the Session API and all 37 MCP tools were healthy — because the
// api_server was advertising a VIRTUAL model name that upstream had stopped
// resolving. No test read the file, so nothing could have caught it.
//
// This is the lesson from the mainnet bank-lane template, restated: an artefact
// is guarded by a test that READS it. A CI step that never opens the file is
// not a guard.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const CONFIG_PATH = join(__dirname, "../../../../hermes/config/hermes.yaml");

interface HermesConfig {
  model?: { default?: string; provider?: string };
  auxiliary?: { background_review?: { model?: string; provider?: string } };
  platforms?: { api_server?: { enabled?: boolean; model_name?: string } };
}

const config = parse(readFileSync(CONFIG_PATH, "utf8")) as HermesConfig;

describe("the api_server advertises a model the provider will actually honour", () => {
  test("model_name is set at all — unset means it advertises `hermes-agent`", () => {
    // Left unset, Hermes advertises its own virtual name in GET /v1/models,
    // clients send that string back, and whether it works depends on upstream
    // still swapping it for the configured model. v0.20.0 stopped doing that.
    expect(config.platforms?.api_server?.model_name).toBeTruthy();
  });

  test("model_name is NOT the virtual name that broke", () => {
    expect(config.platforms?.api_server?.model_name).not.toBe("hermes-agent");
  });

  test("model_name matches model.default — one model, named once", () => {
    // Drift here is silent and asymmetric: the agent answers on model.default
    // while every API client is told to ask for something else. They must be
    // the same string, so that whichever one a code path happens to use, the
    // provider recognises it.
    expect(config.platforms?.api_server?.model_name).toBe(config.model?.default);
  });

  test("the advertised model carries a provider-qualified tag", () => {
    // `glm-5.2:cloud` resolves at ollama.com; a bare product name like
    // `hermes-agent` is what a 404 looks like before it happens. This does not
    // prove the model exists — only a live call does that, which is CHECK 3 in
    // ops/upgrade-hermes.sh — but it catches a name that is obviously not one.
    expect(config.platforms?.api_server?.model_name).toMatch(/:/);
  });
});

describe("the pieces that must not silently diverge", () => {
  test("the api_server platform is still opted in", () => {
    // v0.19.1 needs this opt-in to exist before any API_SERVER_* env var can
    // override it; with no `platforms:` key the gateway binds nothing and
    // reports healthy. Documented at length in the config itself.
    expect(config.platforms?.api_server?.enabled).toBe(true);
  });

  test("the auxiliary lane points at our own provider, not a paid fallback", () => {
    // Unset, this falls through the auxiliary chain to OpenRouter — the gateway
    // logs "PAID lane engaged ... may incur real spend" — and then to Nous
    // Portal, which has no credit. This pin is a spend control.
    expect(config.auxiliary?.background_review?.provider).toBe(config.model?.provider);
    expect(config.auxiliary?.background_review?.model).toBe(config.model?.default);
  });

  test("the OpenRouter auxiliary fallback is structurally unsatisfiable", () => {
    // The pair is the control, not either key alone: free_only makes the
    // client skip any non-:free fallback, and the pinned model is DELIBERATELY
    // the paid default so a future upstream :free default cannot re-open the
    // lane and route aux content (channel text, board data) to a third-party
    // free tier. Observed live before this: "PAID lane engaged" +
    // "payment / credit error" on the gateway, 2026-08-04 → 06.
    expect(config.auxiliary?.free_only).toBe(true);
    const pinned = String(config.auxiliary?.openrouter_model ?? "");
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.endsWith(":free")).toBe(false);
  });
});

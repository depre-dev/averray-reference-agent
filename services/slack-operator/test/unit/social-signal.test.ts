// The social line's contract: report a reading, never a claim, and never let
// "we could not look" render as "there is nothing there".
import { describe, expect, test } from "vitest";

import { buildSocialSignalLine, readSocialSignal } from "../../src/social-signal.js";

function snapshot({
  settled = 142,
  external = 0,
  settledStatus = "fresh",
  externalStatus = "fresh",
  schemaVersion = "averray.transparency.v1",
}: {
  settled?: number;
  external?: number;
  settledStatus?: string;
  externalStatus?: string;
  schemaVersion?: string;
} = {}) {
  return {
    schemaVersion,
    flow: {
      jobsSettled: { allTime: { value: settled, status: settledStatus } },
      composition24h: { external: { value: external, status: externalStatus } },
    },
  };
}

describe("a real reading", () => {
  test("reports both figures plainly", () => {
    const line = buildSocialSignalLine(snapshot());

    expect(line.tone).toBe("ok");
    expect(line.text).toBe("142 settled, no external agents in 24h");
  });

  test("flags the first outside activity — the transition worth a morning", () => {
    const line = buildSocialSignalLine(snapshot({ external: 1 }));

    expect(line.text).toContain("1 external agent in 24h");
    expect(line.text).toContain("worth a post");
    expect(line.tone).toBe("ok");
  });

  test("pluralises more than one external agent", () => {
    expect(buildSocialSignalLine(snapshot({ external: 3 })).text).toContain("3 external agents");
  });
});

describe("a reading we cannot fully vouch for", () => {
  test("a stale field is labelled, never shown as current", () => {
    const line = buildSocialSignalLine(snapshot({ settledStatus: "stale" }));

    expect(line.text).toContain("142 settled (stale)");
    expect(line.tone).toBe("degraded");
  });

  test("a stale external count never earns the 'worth a post' flag", () => {
    const line = buildSocialSignalLine(snapshot({ external: 2, externalStatus: "stale" }));

    expect(line.text).not.toContain("worth a post");
    expect(line.tone).toBe("degraded");
  });
});

describe("the instruments failing must not look like a fact about the product", () => {
  test("a payload of the wrong shape shows NO figures", () => {
    const line = buildSocialSignalLine({ schemaVersion: "averray.transparency.v2" });

    expect(line.tone).toBe("degraded");
    expect(line.text).toContain("shape we do not know");
    expect(line.text).not.toMatch(/\d+ settled/);
  });

  test("a useless body shows NO figures — never 'no external agents'", () => {
    const line = buildSocialSignalLine({});

    expect(line.tone).toBe("degraded");
    expect(line.text).not.toContain("no external agents");
  });

  test("a right-shaped payload carrying no figures says exactly that", () => {
    const line = buildSocialSignalLine({ schemaVersion: "averray.transparency.v1", flow: {} });

    expect(line.tone).toBe("degraded");
    expect(line.text).toBe("public record answered but carried no figures");
  });

  test("an empty reading and a zero reading never render the same", () => {
    const broken = buildSocialSignalLine({});
    const real = buildSocialSignalLine(snapshot({ external: 0 }));

    expect(broken.text).not.toBe(real.text);
    expect(broken.tone).not.toBe(real.tone);
  });
});

describe("fetching", () => {
  const env = { AVERRAY_API_BASE_URL: "https://api.example.test" } as NodeJS.ProcessEnv;

  test("unconfigured means absent, not degraded — the feature is simply off", async () => {
    expect(await readSocialSignal({ env: {} as NodeJS.ProcessEnv })).toBeNull();
  });

  test("a non-200 degrades with the status and no figures", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const line = await readSocialSignal({ env, fetchImpl });

    expect(line?.tone).toBe("degraded");
    expect(line?.text).toContain("503");
  });

  test("a thrown fetch degrades instead of taking the digest down with it", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const line = await readSocialSignal({ env, fetchImpl });

    expect(line?.tone).toBe("degraded");
    expect(line?.text).toContain("ECONNREFUSED");
  });

  test("a trailing slash on the base URL does not produce a double slash", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return { ok: true, status: 200, json: async () => snapshot() };
    }) as unknown as typeof fetch;

    await readSocialSignal({ env: { AVERRAY_API_BASE_URL: "https://api.example.test/" }, fetchImpl });

    expect(seen).toBe("https://api.example.test/transparency");
  });
});

import { describe, expect, it } from "vitest";

import {
  classifyTransportFailure,
  describeTransportFailure,
  trackTransportFailure,
  transportFailureIsPageWorthy,
} from "../../services/slack-operator/src/probe-transport.js";

/** The shape undici actually throws: a useless outer message, the truth inside. */
const undiciFetchFailure = (code: string, message: string): Error => {
  const inner = Object.assign(new Error(message), { code });
  return Object.assign(new TypeError("fetch failed"), { cause: inner });
};

describe("classifyTransportFailure", () => {
  it("digs the cause code out from under undici's 'fetch failed'", () => {
    // This is the entire reason a five-minute DNS incident was reported to a
    // human as "fetch failed": the code was one level down and nobody looked.
    const f = classifyTransportFailure(undiciFetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND api.averray.com"));
    expect(f.code).toBe("ENOTFOUND");
    expect(f.kind).toBe("dns");
    expect(f.message).toContain("api.averray.com");
  });

  it("reaches through an AggregateError of per-address attempts", () => {
    const attempt = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    const aggregate = Object.assign(new AggregateError([attempt], "all attempts failed"), {});
    const outer = Object.assign(new TypeError("fetch failed"), { cause: aggregate });
    expect(classifyTransportFailure(outer)).toMatchObject({ code: "ECONNREFUSED", kind: "connect" });
  });

  it("classifies TLS and timeout faults distinctly from DNS", () => {
    expect(classifyTransportFailure(undiciFetchFailure("CERT_HAS_EXPIRED", "certificate has expired")).kind).toBe("tls");
    expect(classifyTransportFailure(undiciFetchFailure("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")).kind).toBe("connect");
    expect(classifyTransportFailure(undiciFetchFailure("ETIMEDOUT", "timed out")).kind).toBe("timeout");
  });

  it("says UNKNOWN rather than inventing a code", () => {
    const f = classifyTransportFailure(new Error("something went sideways"));
    expect(f.code).toBe("UNKNOWN");
    // …and then the message carries what little there is, rather than nothing.
    expect(describeTransportFailure(f)).toContain("something went sideways");
  });

  it("does not loop on a self-referential cause chain", () => {
    const err = new Error("round and round") as Error & { cause?: unknown };
    err.cause = err;
    expect(classifyTransportFailure(err).message).toBe("round and round");
  });

  it("names the layer and the code, for reading and for grepping", () => {
    const f = classifyTransportFailure(undiciFetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND api.averray.com"));
    expect(describeTransportFailure(f)).toBe("DNS resolution failed (ENOTFOUND)");
  });
});

describe("trackTransportFailure", () => {
  const dns = { kind: "dns" as const, code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.averray.com" };

  it("counts consecutive failures", () => {
    let run = trackTransportFailure(undefined, dns);
    expect(run).toEqual({ code: "ENOTFOUND", consecutive: 1 });
    run = trackTransportFailure(run, dns);
    run = trackTransportFailure(run, dns);
    expect(run?.consecutive).toBe(3);
  });

  it("clears the moment a read succeeds", () => {
    const run = trackTransportFailure(trackTransportFailure(undefined, dns), dns);
    expect(trackTransportFailure(run, undefined)).toBeUndefined();
  });

  it("keeps counting when the code changes mid-outage", () => {
    // A real outage walks through codes. Restarting the count on each one would
    // keep the hold armed forever, which is a way to never page at all.
    const first = trackTransportFailure(undefined, dns);
    const second = trackTransportFailure(first, { kind: "connect", code: "ECONNREFUSED", message: "refused" });
    expect(second).toEqual({ code: "ECONNREFUSED", consecutive: 2 });
  });
});

describe("transportFailureIsPageWorthy", () => {
  it("does not page on a single-shot failure", () => {
    expect(transportFailureIsPageWorthy({ code: "ENOTFOUND", consecutive: 1 }, 3)).toBe(false);
    expect(transportFailureIsPageWorthy({ code: "ENOTFOUND", consecutive: 2 }, 3)).toBe(false);
  });

  it("pages once the fault has persisted", () => {
    expect(transportFailureIsPageWorthy({ code: "ENOTFOUND", consecutive: 3 }, 3)).toBe(true);
    expect(transportFailureIsPageWorthy({ code: "ENOTFOUND", consecutive: 9 }, 3)).toBe(true);
  });

  it("never pages with no run at all", () => {
    expect(transportFailureIsPageWorthy(undefined, 3)).toBe(false);
  });

  it("treats a threshold below 1 as 1 rather than as 'never'", () => {
    expect(transportFailureIsPageWorthy({ code: "ENOTFOUND", consecutive: 1 }, 0)).toBe(true);
  });
});

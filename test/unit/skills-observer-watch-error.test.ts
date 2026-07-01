import { describe, expect, it } from "vitest";

import { describeWatchError } from "../../services/skills-observer/src/watch-error.js";

describe("describeWatchError", () => {
  it("marks EACCES as retryable with a UID-10000 remediation hint", () => {
    const disposition = describeWatchError(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(disposition.retryable).toBe(true);
    expect(disposition.logKey).toBe("skills_observer_watch_unavailable");
    expect(disposition.remediation).toMatch(/10000/);
    expect(disposition.remediation).toMatch(/EACCES/);
  });

  it("marks EPERM and ENOENT as retryable too", () => {
    expect(describeWatchError(Object.assign(new Error(), { code: "EPERM" })).retryable).toBe(true);
    expect(describeWatchError(Object.assign(new Error(), { code: "ENOENT" })).retryable).toBe(true);
  });

  it("marks an unknown error code as non-retryable with the generic log key", () => {
    const disposition = describeWatchError(Object.assign(new Error("boom"), { code: "EMFILE" }));
    expect(disposition.retryable).toBe(false);
    expect(disposition.logKey).toBe("skills_observer_error");
    expect(disposition.remediation).toBeUndefined();
  });

  it("handles a plain Error and non-error values without throwing", () => {
    expect(describeWatchError(new Error("boom")).retryable).toBe(false);
    expect(describeWatchError(undefined).retryable).toBe(false);
    expect(describeWatchError("nope").retryable).toBe(false);
    expect(describeWatchError(null).retryable).toBe(false);
  });
});

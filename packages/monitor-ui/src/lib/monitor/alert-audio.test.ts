import { test, assert } from "vitest";

import { playAlertTone, type MinimalAudioContext } from "./alert-audio.js";

function fakeCtx() {
  const calls: string[] = [];
  const osc = {
    type: "",
    frequency: { value: 0 },
    connect: () => calls.push("osc.connect"),
    start: () => calls.push("osc.start"),
    stop: () => calls.push("osc.stop"),
  };
  const gain = {
    gain: {
      value: 0,
      setValueAtTime: () => calls.push("gain.setValueAtTime"),
      exponentialRampToValueAtTime: () => calls.push("gain.ramp"),
    },
    connect: () => calls.push("gain.connect"),
  };
  const ctx = {
    currentTime: 0,
    destination: {},
    createOscillator: () => osc,
    createGain: () => gain,
  };
  return { ctx: ctx as unknown as MinimalAudioContext, osc, gain, calls };
}

test("playAlertTone routes a 880Hz sine through a decaying gain to the destination", () => {
  const { ctx, osc, calls } = fakeCtx();
  playAlertTone(ctx);
  assert.equal(osc.type, "sine");
  assert.equal(osc.frequency.value, 880);
  // Envelope: an initial set + an attack ramp + a decay ramp.
  assert.ok(calls.includes("gain.setValueAtTime"));
  assert.equal(calls.filter((c) => c === "gain.ramp").length, 2);
  // Routed and scheduled.
  assert.ok(calls.includes("osc.connect"));
  assert.ok(calls.includes("gain.connect"));
  assert.ok(calls.includes("osc.start"));
  assert.ok(calls.includes("osc.stop"));
});

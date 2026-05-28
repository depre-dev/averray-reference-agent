// Hermes Handoff Monitor — procedural alert tone (§21.3).
//
// A soft sine-wave chime, ~200ms, exponential decay — generated with the
// Web Audio API rather than shipping an audio asset (per the §21.3
// decision; the operator can swap in an uploaded file later). The
// AudioContext is injected so the tone is testable without a real audio
// backend and so the caller controls context lifecycle / autoplay-policy
// resume.

/** The slice of AudioContext this tone needs (keeps tests fake-able). */
export interface MinimalAudioContext {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

const PEAK_GAIN = 0.18;
const FLOOR_GAIN = 0.0001;
const DURATION_S = 0.2;

/** Play the alert chime on the given context. */
export function playAlertTone(ctx: MinimalAudioContext): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.value = 880; // a calm, mid-high chime

  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(FLOOR_GAIN, t0);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t0 + 0.02); // quick attack
  gain.gain.exponentialRampToValueAtTime(FLOOR_GAIN, t0 + DURATION_S); // exp decay

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + DURATION_S + 0.02);
}

import { useId, useState, type FormEvent } from "react";
import type {
  MissionLaunchInput,
  MissionLaunchMode,
  MissionLaunchOutcome,
  MissionLaunchResult,
  SaveTestSuiteInput,
} from "../lib/monitor/mission-launch.js";

const DEFAULT_TARGET = "https://app.averray.com";

export interface StartMissionLauncherProps {
  onSpawnMission?: (input: MissionLaunchInput) => MissionLaunchOutcome;
  onSaveSuite?: (input: SaveTestSuiteInput) => void;
}

type LaunchFeedback = { ok: boolean; detail: string };

export function StartMissionLauncher({ onSpawnMission, onSaveSuite }: StartMissionLauncherProps) {
  const targetId = useId();
  const jobIdId = useId();
  const goalId = useId();
  const suiteNameId = useId();
  const [open, setOpen] = useState(false);
  const [targetUrl, setTargetUrl] = useState(DEFAULT_TARGET);
  const [jobId, setJobId] = useState("");
  const [mode, setMode] = useState<MissionLaunchMode>("surface_sweep");
  const [freshMemory, setFreshMemory] = useState(true);
  const [requestApproval, setRequestApproval] = useState(false);
  const [saveSuite, setSaveSuite] = useState(false);
  const [suiteName, setSuiteName] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<LaunchFeedback | null>(null);

  const isCitation = mode === "citation_repair";

  // Turn the spawn outcome into honest feedback. `undefined` means the handler
  // is fire-and-forget (the /mission command path or a test mock) — best-effort
  // "requested". A reported { ok:false } becomes an explicit failure line.
  const applyOutcome = (outcome: MissionLaunchResult | void) => {
    setPending(false);
    if (outcome && outcome.ok === false) {
      const why = outcome.status ? `HTTP ${outcome.status}` : (outcome.error ?? "request failed");
      setFeedback({ ok: false, detail: why });
      return;
    }
    setFeedback({
      ok: true,
      detail: requestApproval
        ? "queued — approve it in the Decision Inbox"
        : "it’ll appear in the Hermes-checking lane",
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = targetUrl.trim();
    const trimmedJobId = jobId.trim();
    // citation_repair keys off a Job ID (or auto-selects), not a URL — so it
    // skips the http(s) target check.
    if (!isCitation && !isHttpUrl(target)) {
      setError("Use an http:// or https:// target.");
      return;
    }
    if (saveSuite && !suiteName.trim()) {
      setError("Name the suite before saving it.");
      return;
    }
    setError(null);
    setFeedback(null);
    const trimmedGoal = goal.trim();
    // Spawn first (so the mission POST precedes the suite POST), then the
    // optional suite save — both fired synchronously before we await the
    // outcome, so a fire-and-forget handler stays fully synchronous.
    const outcome = onSpawnMission?.({
      // citation_repair omits the target server-side; the launch body drops it.
      targetUrl: isCitation ? "" : target,
      mode,
      freshMemory,
      initialStatus: requestApproval ? "requested" : "ready",
      ...(isCitation && trimmedJobId ? { jobId: trimmedJobId } : {}),
      ...(trimmedGoal ? { goal: trimmedGoal } : {}),
    });
    if (saveSuite) {
      onSaveSuite?.({
        name: suiteName.trim(),
        target: isCitation ? (trimmedJobId || "auto-select") : target,
        mode,
        author: "operator",
        ...(trimmedGoal ? { goal: trimmedGoal } : {}),
      });
    }
    // A thenable result → await it for the real POST status; a sync/void handler
    // resolves immediately. The panel stays open so the feedback is visible
    // (the silent close was the "nothing happens" report).
    if (outcome && typeof (outcome as { then?: unknown }).then === "function") {
      setPending(true);
      Promise.resolve(outcome as Promise<MissionLaunchResult | void>)
        .then(applyOutcome)
        .catch(() => {
          setPending(false);
          setFeedback({ ok: false, detail: "request failed" });
        });
    } else {
      applyOutcome(outcome as MissionLaunchResult | void);
    }
  };

  return (
    <section className="hm-mission-launcher" aria-label="Start a mission">
      <div className="hm-mission-launcher-head">
        <div>
          <span className="hm-mission-launcher-kicker">Tester</span>
          <strong>Start a mission</strong>
          <span>Launch a real browser run from the board.</span>
        </div>
        <button type="button" className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Start a mission"}
        </button>
      </div>

      {open ? (
        <form className="hm-mission-launcher-form" onSubmit={submit}>
          {isCitation ? (
            <label className="hm-field hm-field--wide" htmlFor={jobIdId}>
              <span>Job ID</span>
              <input
                id={jobIdId}
                type="text"
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="Leave empty to auto-select a claimable job"
              />
              <small>read-only analysis — no claim or edit (dry run)</small>
            </label>
          ) : (
            <label className="hm-field hm-field--wide" htmlFor={targetId}>
              <span>Target</span>
              <input
                id={targetId}
                type="url"
                required
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                placeholder={DEFAULT_TARGET}
              />
            </label>
          )}

          <fieldset className="hm-choice-group">
            <legend>Flow</legend>
            <label>
              <input
                type="radio"
                name="mission-flow"
                checked={mode === "surface_sweep"}
                onChange={() => setMode("surface_sweep")}
              />
              <span>Surface Sweep</span>
              <small>read-only</small>
            </label>
            <label>
              <input
                type="radio"
                name="mission-flow"
                checked={mode === "gold_path"}
                onChange={() => setMode("gold_path")}
              />
              <span>Gold Path</span>
              <small>testnet</small>
            </label>
            <label>
              <input
                type="radio"
                name="mission-flow"
                checked={mode === "siwe_auth"}
                onChange={() => setMode("siwe_auth")}
              />
              <span>Role Gating</span>
              <small>read-only</small>
            </label>
            <label>
              <input
                type="radio"
                name="mission-flow"
                checked={mode === "citation_repair"}
                onChange={() => setMode("citation_repair")}
              />
              <span>Citation Repair</span>
              <small>read-only</small>
            </label>
          </fieldset>

          <fieldset className="hm-choice-group hm-choice-group--compact">
            <legend>Memory</legend>
            <label>
              <input
                type="radio"
                name="mission-memory"
                checked={freshMemory}
                onChange={() => setFreshMemory(true)}
              />
              <span>Fresh</span>
            </label>
            <label>
              <input
                type="radio"
                name="mission-memory"
                checked={!freshMemory}
                onChange={() => setFreshMemory(false)}
              />
              <span>Memory</span>
            </label>
          </fieldset>

          <label className="hm-field hm-field--wide" htmlFor={goalId}>
            <span>Goal</span>
            <textarea
              id={goalId}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Optional scope or question for the browser agent"
              rows={2}
            />
          </label>

          <label className="hm-checkbox-row">
            <input
              type="checkbox"
              checked={requestApproval}
              onChange={(event) => setRequestApproval(event.target.checked)}
            />
            <span>Request approval before the runner claims it</span>
          </label>

          {onSaveSuite ? (
            <>
              <label className="hm-checkbox-row">
                <input
                  type="checkbox"
                  checked={saveSuite}
                  onChange={(event) => setSaveSuite(event.target.checked)}
                />
                <span>Save this config as a suite</span>
              </label>
              {saveSuite ? (
                <label className="hm-field" htmlFor={suiteNameId}>
                  <span>Suite name</span>
                  <input
                    id={suiteNameId}
                    value={suiteName}
                    onChange={(event) => setSuiteName(event.target.value)}
                    placeholder="Daily app sweep"
                  />
                </label>
              ) : null}
            </>
          ) : null}

          {error ? <div className="hm-form-error" role="alert">{error}</div> : null}
          {feedback ? (
            feedback.ok ? (
              <div className="hm-form-ok" role="status">Mission requested ✓ — {feedback.detail}.</div>
            ) : (
              <div className="hm-form-error" role="alert">
                Launch failed — {feedback.detail}. The board can’t confirm it; check the tester runner.
              </div>
            )
          ) : null}

          <div className="hm-mission-launcher-actions">
            <button type="submit" className="hm-btn hm-btn--action" disabled={pending}>
              {pending ? "Launching…" : "Launch mission"}
            </button>
            <span>Server derives mutation safety from target, flow, and environment.</span>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

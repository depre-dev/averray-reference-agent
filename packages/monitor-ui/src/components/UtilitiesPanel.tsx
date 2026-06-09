import { useEffect, useState } from "react";
import type { LlmUsageAggregate } from "../lib/monitor/board-cache.js";
import type { MissionLaunchOutcome, MissionSpawnInput, SavedTestSuite, SaveTestSuiteInput } from "../lib/monitor/mission-launch.js";
import { formatCompactNumber } from "../lib/monitor/format.js";
import { UsagePanel } from "./UsagePanel.js";
import { TestSuitesPanel } from "./TestSuitesPanel.js";
import { StartMissionLauncher } from "./StartMissionLauncher.js";
import { Badge } from "./ui.js";

export interface UtilitiesPanelProps {
  usage?: LlmUsageAggregate;
  suites?: SavedTestSuite[];
  onRunSuite?: (id: string) => void;
  onSaveSuite?: (input: SaveTestSuiteInput) => void;
  onApproveSuite?: (id: string) => void;
  onDismissSuite?: (id: string) => void;
  onSpawnMission?: (input: MissionSpawnInput) => MissionLaunchOutcome;
}

/**
 * The supporting Utilities row: a collapsed strip that expands into a calm,
 * two-column card surface — real LLM usage on the left, the mission launcher
 * over the saved-suite library on the right. Secondary to the board; the only
 * coral is the selected mission flow. Auto-opens when a suite is awaiting the
 * operator (a requested agent-authored suite).
 */
export function UtilitiesPanel({
  usage,
  suites = [],
  onRunSuite,
  onSaveSuite,
  onApproveSuite,
  onDismissSuite,
  onSpawnMission,
}: UtilitiesPanelProps) {
  const requestedSuites = suites.filter((suite) => suite.status === "requested").length;
  const shouldOpen = requestedSuites > 0;
  const [open, setOpen] = useState(shouldOpen);
  useEffect(() => {
    if (shouldOpen) setOpen(true);
  }, [shouldOpen]);

  const usageLabel = usage?.status === "recorded"
    ? `${formatCompactNumber(usage.totalTokens)} tokens`
    : "usage quiet";
  const suitesLabel = suites.length > 0
    ? `${suites.length} suite${suites.length === 1 ? "" : "s"}`
    : "no suites";
  const launcherLabel = onSpawnMission ? "tester ready" : "tester off";

  return (
    <section className={`hm-utility-bar${requestedSuites > 0 ? " hm-utility-bar--attention" : ""}`} aria-label="Board utilities">
      <button
        type="button"
        className="hm-utility-bar-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="hm-kicker">Utilities</span>
        <strong>LLM usage · suites · tester launcher</strong>
        <span className="hm-utility-bar-summary">
          {open ? "collapse" : `${usageLabel} · ${suitesLabel} · ${launcherLabel}`}
        </span>
        {requestedSuites > 0 ? <Badge variant="pending">{requestedSuites} requested</Badge> : null}
      </button>
      {open ? (
        <div className="hm-utility-bar-body">
          <UsagePanel usage={usage} />
          <div className="hm-util-right">
            {onSpawnMission ? <StartMissionLauncher onSpawnMission={onSpawnMission} onSaveSuite={onSaveSuite} /> : null}
            <TestSuitesPanel
              suites={suites}
              onRunSuite={onRunSuite}
              onSaveSuite={onSaveSuite}
              onApproveSuite={onApproveSuite}
              onDismissSuite={onDismissSuite}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

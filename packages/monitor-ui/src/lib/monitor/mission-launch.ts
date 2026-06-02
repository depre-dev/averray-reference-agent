export type MissionLaunchMode = "surface_sweep" | "gold_path";
export type MissionInitialStatus = "ready" | "requested";

export interface MissionLaunchInput {
  targetUrl: string;
  mode: MissionLaunchMode;
  freshMemory: boolean;
  initialStatus: MissionInitialStatus;
  goal?: string;
}

export type MissionSpawnInput = string | MissionLaunchInput;

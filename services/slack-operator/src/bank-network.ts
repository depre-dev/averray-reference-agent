import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Is slack-operator actually on the bank lane's network?
//
// ops/deploy-monitor.sh adds ops/compose.bank-feed.yml only when
// agent-mainnet-internal already exists. If the platform network appears
// later, or a deploy skipped the overlay, the container stays off it. The
// bank feed URL is then configured and unresolvable, and the lane says
// "fetch failed" instead of naming the missing attachment.
//
// This check fires only when the network EXISTS and this container is not a
// member. A missing network is the deploy script's "skipped the overlay"
// note, not this fault: the board must still boot when the platform is down.

export const AGENT_MAINNET_NETWORK = "agent-mainnet-internal";

export const BANK_NETWORK_DETACHED =
  "slack-operator is not on agent-mainnet-internal while that network exists — redeploy the monitor with ops/deploy-monitor.sh";

export const BANK_FEED_NETWORK_DETACHED =
  "bank feed network not attached — redeploy the monitor with ops/deploy-monitor.sh";

export interface BankNetworkAttachment {
  /** False when we could not see Docker's view. Absence is not a fault. */
  observable: boolean;
  networkExists: boolean;
  attached: boolean;
  /** Set only when the network exists and this container is not on it. */
  detail?: string;
}

/**
 * The attachment decision, given Docker's view of one network.
 *
 * `containers` are ids and names currently connected. `self` is this
 * container's id or name. A network that is not in the inspect result does
 * not exist; that is not "detached".
 */
export function decideBankNetworkAttachment(input: {
  networkExists: boolean;
  containers?: readonly string[];
  self?: string;
}): BankNetworkAttachment {
  if (!input.networkExists) {
    return { observable: true, networkExists: false, attached: false };
  }
  const self = (input.self ?? "").trim().toLowerCase();
  const containers = (input.containers ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  const attached = self.length > 0 && containers.some((c) => c === self || c.startsWith(self) || self.startsWith(c));
  if (!attached) {
    return { observable: true, networkExists: true, attached: false, detail: BANK_NETWORK_DETACHED };
  }
  return { observable: true, networkExists: true, attached: true };
}

interface DockerNetworkInspect {
  Name?: unknown;
  Containers?: unknown;
}

/** Parse `docker network inspect agent-mainnet-internal`. Missing network → exists false. */
export function attachmentFromDockerInspect(input: {
  inspect: unknown;
  selfId: string;
  selfName?: string;
}): BankNetworkAttachment {
  const list = Array.isArray(input.inspect) ? input.inspect : input.inspect ? [input.inspect] : [];
  const network = list.find((item): item is DockerNetworkInspect => {
    if (!item || typeof item !== "object") return false;
    return (item as DockerNetworkInspect).Name === AGENT_MAINNET_NETWORK;
  });
  if (!network) return decideBankNetworkAttachment({ networkExists: false });
  const containers = network.Containers;
  const members: string[] = [];
  if (containers && typeof containers === "object") {
    for (const [id, meta] of Object.entries(containers as Record<string, unknown>)) {
      members.push(id);
      if (meta && typeof meta === "object" && typeof (meta as { Name?: unknown }).Name === "string") {
        members.push((meta as { Name: string }).Name);
      }
    }
  }
  const self = input.selfId || input.selfName || "";
  const byId = decideBankNetworkAttachment({ networkExists: true, containers: members, self });
  if (byId.attached || !input.selfName) return byId;
  return decideBankNetworkAttachment({ networkExists: true, containers: members, self: input.selfName });
}

/**
 * Docker's view of agent-mainnet-internal, from this process.
 *
 * Unobservable — not a fault — when Docker cannot be asked (the monitor image
 * has no client, or the daemon is absent). Vitest never shells out.
 */
export async function observeBankNetworkAttachment(): Promise<BankNetworkAttachment> {
  if (process.env.VITEST) return { observable: false, networkExists: false, attached: false };
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["network", "inspect", AGENT_MAINNET_NETWORK],
      { timeout: 1500 },
    );
    return attachmentFromDockerInspect({ inspect: JSON.parse(stdout), selfId: hostname() });
  } catch {
    return { observable: false, networkExists: false, attached: false };
  }
}

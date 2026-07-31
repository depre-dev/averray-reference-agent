// Disk headroom — the pillar nobody was watching.
//
// The seven existing probes cover the product and the money. None watch the
// disk the monitor itself runs on, and a full disk is a CORRELATED failure: it
// takes the monitor, the money board and the alert path in the same moment. The
// thing meant to warn you dies with the thing it is watching, and it dies
// quietly — no page, no red probe, just a board that stopped updating.
//
// That was tolerable while disk sat flat. It stops being tolerable the moment
// Buzz brings MinIO, because media storage grows with USE rather than staying
// level (see docs/HERMES_UPGRADE_v019.md §4.4).
//
// Container visibility, verified on the live box 2026-07-31 rather than assumed:
// the monitor's overlay `/` reports the SAME 193G/155G as the host, and `/data`
// is the same `/dev/sda1`. So `fs.statfsSync("/")` sees real host capacity — no
// host mount, no shelling out to `df`.

import { statfsSync } from "node:fs";

import type { ProbeResult } from "./product-health.js";

const BYTES_PER_GB = 1024 ** 3;

export interface DiskUsage {
  /** Total capacity in bytes; null when unreadable. */
  totalBytes: number | null;
  /**
   * Bytes available TO US. Deliberately `bavail`, not `bfree`: `bfree` counts
   * root-reserved blocks we cannot actually write to, so it would overstate
   * headroom by a few percent right at the point it matters.
   */
  availableBytes: number | null;
}

/**
 * Read the filesystem the monitor actually writes to. Never throws; any failure
 * returns nulls, which `decideDiskHeadroom` reports as unreadable rather than
 * as healthy.
 */
export function readDiskUsage(path = "/"): DiskUsage {
  try {
    const s = statfsSync(path);
    const total = Number(s.blocks) * Number(s.bsize);
    const available = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) {
      return { totalBytes: null, availableBytes: null };
    }
    return { totalBytes: total, availableBytes: available };
  } catch {
    return { totalBytes: null, availableBytes: null };
  }
}

/**
 * The verdict. PURE — the measurement is injected so the thresholds are
 * testable without a filesystem.
 *
 * Judged on ABSOLUTE free space, not percentage. Percentage is the intuitive
 * number and the wrong one: 5% of a 2 TB disk is 100 GB of comfort, while 20%
 * of a 20 GB disk is 4 GB and about to fail. Writes fail on bytes. The percent
 * is reported alongside because it is what a human reads at a glance, but it
 * never decides the status.
 */
export function decideDiskHeadroom(input: {
  usage: DiskUsage;
  /** Below this ⇒ red. */
  minFreeGb: number;
  /** Below this ⇒ degraded. Ignored when <= minFreeGb. */
  warnFreeGb: number;
}): ProbeResult {
  const name = "disk_headroom";
  const { totalBytes, availableBytes } = input.usage;
  if (totalBytes === null || availableBytes === null) {
    // Unreadable is NOT healthy. A probe that cannot see must not report calm —
    // that is the fake-green this whole board exists to avoid.
    return { name, status: "degraded", detail: "disk headroom unreadable — capacity NOT verified" };
  }
  const freeGb = availableBytes / BYTES_PER_GB;
  const totalGb = totalBytes / BYTES_PER_GB;
  const usedPct = Math.round(((totalBytes - availableBytes) / totalBytes) * 100);
  const where = `${freeGb.toFixed(1)} GiB free of ${totalGb.toFixed(0)} GiB (${usedPct}% used)`;

  if (freeGb < input.minFreeGb) {
    return { name, status: "red", detail: `${where} — below the ${input.minFreeGb} GiB floor; writes are at risk` };
  }
  if (input.warnFreeGb > input.minFreeGb && freeGb < input.warnFreeGb) {
    return { name, status: "degraded", detail: `${where} — under the ${input.warnFreeGb} GiB warning line` };
  }
  return { name, status: "ok", detail: where };
}

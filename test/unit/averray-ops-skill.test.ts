// The ops skill is a DELIVERABLE, and its failure mode is silence.
//
// Every way this file can be wrong — misnamed, misplaced, unparseable
// frontmatter, a trigger that does not name the question being asked — produces
// no error anywhere. Hermes simply never loads it, which reads as the agent
// ignoring its guidance rather than as a broken file. This document spent its
// first weeks in exactly that state, and a duplicate copy survived on main
// through two squash merges without a single test noticing.
//
// So the shape gets asserted here. These tests do not check prose; they check
// the handful of properties that decide whether the prose is ever read.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillPath = join(repoRoot, "hermes", "skills", "ops", "averray-ops", "SKILL.md");

const raw = readFileSync(skillPath, "utf8");

function frontmatter(text: string): { name: string; description: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no YAML frontmatter");
  const block = match[1]!;
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!name || !description) throw new Error("frontmatter missing name or description");
  return { name, description };
}

describe("averray-ops skill file shape", () => {
  it("is named SKILL.md inside a directory named for the skill", () => {
    // Hermes discovers skills with `skills_dir.rglob("SKILL.md")`, and takes the
    // skill name from the parent directory and the category from its
    // grandparent. A flat `averray-ops.md` is never found at all.
    expect(skillPath.endsWith(join("ops", "averray-ops", "SKILL.md"))).toBe(true);
    expect(frontmatter(raw).name).toBe("averray-ops");
  });

  it("has a single-line description — a wrapped one breaks the YAML", () => {
    const { description } = frontmatter(raw);
    expect(description).not.toContain("\n");
    expect(description.length).toBeGreaterThan(80);
  });
});

describe("the description is a TRIGGER, not a label", () => {
  const { description } = frontmatter(raw);
  const lower = description.toLowerCase();

  it("names the money-path questions it should answer", () => {
    for (const term of ["money path", "payouts", "settlements", "solvency", "verdict"]) {
      expect(lower).toContain(term);
    }
  });

  it("names wallet and funding questions", () => {
    // THE REGRESSION. The first version of this description listed only board
    // and money-path vocabulary — no wallet, address, gas, DOT or top-up. Asked
    // "where do I send DOT to top up the signer's gas", the model matched
    // nothing here, never reached the board, and answered from the agent's own
    // `wallet_export_address` instead: a real, valid-looking address that is not
    // the gas signer, plus invented advice that the transfer needed a bridge.
    //
    // A skill that does not advertise a question does not get asked it.
    for (const term of ["wallet", "address", "gas", "dot", "usdc"]) {
      expect(lower).toContain(term);
    }
  });

  it("puts the funding vocabulary early, before any truncation could bite", () => {
    // Hermes's truncation behaviour for long descriptions is not verified, so
    // the clause whose absence produced a wrong money answer leads rather than
    // trails. This is cheap insurance, not a claim about the limit.
    expect(description.slice(0, 260).toLowerCase()).toContain("wallet");
  });
});

describe("the body carries the facts that were answered wrongly", () => {
  const lower = raw.toLowerCase();

  it("separates the agent's own wallet from operator infrastructure", () => {
    // "signer" means two different things across these tools: the operator's gas
    // account, and the agent's SIWE login identity. That collision is what
    // produced the wrong answer, so the file has to name it explicitly.
    expect(lower).toContain("wallet_export_address");
    expect(lower).toContain("siwefallbackmode");
  });

  it("says plainly that no bridge is involved", () => {
    // pallet_revive maps H160 -> AccountId32 by appending twelve 0xEE bytes, so
    // the 0x form and the SS58 form are the same account and a Substrate wallet
    // can fund gas directly. Inventing a bridge strands a top-up during an
    // outage, which is exactly when the question gets asked.
    expect(lower).toContain("no bridge");
    expect(lower).toContain("0xee");
  });

  it("still says only the signer takes funds, and the rest are contracts", () => {
    expect(lower).toContain("lands somewhere with no way back");
  });
});

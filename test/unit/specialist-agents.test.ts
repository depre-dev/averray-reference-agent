import { describe, expect, it } from "vitest";

import {
  DOCS_AGENT_ID,
  DOCS_ROLE_PROMPT,
  INTERNAL_SPECIALIST_AGENTS,
  SECURITY_AGENT_ID,
  SECURITY_ROLE_PROMPT,
  specialistAgentDefinition,
} from "../../services/slack-operator/src/specialist-agents.js";
import { buildGuardedClaudePrompt, claudeBranchName, type ClaudeWorkerTask } from "../../services/slack-operator/src/claude-branch-worker.js";

const baseTask: ClaudeWorkerTask = {
  id: "task-averray-agent-agent-abc123",
  repo: "depre-dev/averray-reference-agent",
  title: "Review auth boundaries",
  prompt: "Review auth handling and propose fixes.",
};

describe("C3 specialist agent templates", () => {
  it("registers the security specialist as proposes-only with operator escalation", () => {
    const specialist = specialistAgentDefinition(SECURITY_AGENT_ID);

    expect(specialist).toMatchObject({
      id: "security",
      label: "Security",
      branchPrefix: "security",
      greenfield: true,
      prBodyLabel: "security specialist",
      roleTitle: "SECURITY",
    });
    expect(SECURITY_ROLE_PROMPT).toContain("SECURITY ROLE");
    expect(SECURITY_ROLE_PROMPT).toContain("Proposes-only");
    expect(SECURITY_ROLE_PROMPT).toContain("high-risk findings");
    expect(SECURITY_ROLE_PROMPT).toContain("polkadot-docs MCP");
    expect(SECURITY_ROLE_PROMPT).toContain("Never print secrets");
  });

  it("registers the docs specialist as a docs-first proposer", () => {
    const specialist = specialistAgentDefinition(DOCS_AGENT_ID);

    expect(specialist).toMatchObject({
      id: "docs",
      label: "Docs",
      branchPrefix: "docs",
      greenfield: true,
      prBodyLabel: "docs specialist",
      roleTitle: "DOCS",
    });
    expect(DOCS_ROLE_PROMPT).toContain("DOCS ROLE");
    expect(DOCS_ROLE_PROMPT).toContain("documentation updates");
    expect(DOCS_ROLE_PROMPT).toContain("do not claim behavior is shipped unless code evidence proves it");
  });

  it("injects each specialist prompt into the shared Claude-family worker seam", () => {
    const securityBranch = claudeBranchName({ ...baseTask, agent: "security" });
    const docsBranch = claudeBranchName({ ...baseTask, agent: "docs", title: "Update runbook" });

    expect(securityBranch).toMatch(/^security\/[a-z0-9-]+$/);
    expect(docsBranch).toMatch(/^docs\/[a-z0-9-]+$/);
    expect(buildGuardedClaudePrompt({ ...baseTask, agent: "security" }, securityBranch)).toContain(SECURITY_ROLE_PROMPT);
    expect(buildGuardedClaudePrompt({ ...baseTask, agent: "docs" }, docsBranch)).toContain(DOCS_ROLE_PROMPT);
  });

  it("keeps the roster modular", () => {
    expect(INTERNAL_SPECIALIST_AGENTS.map((agent) => agent.id)).toEqual(["test-writer", "security", "docs"]);
  });
});

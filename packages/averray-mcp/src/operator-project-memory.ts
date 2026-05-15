import { optionalEnv } from "@avg/mcp-common";

export interface ProjectMemoryInput {
  project?: string;
  query?: string;
}

export interface ProjectMemoryEntry {
  id: string;
  name: string;
  aliases: string[];
  repos: string[];
  role: string;
  owner: string;
  environments: Array<Record<string, unknown>>;
  surfaces: Array<Record<string, unknown>>;
  deploy: Record<string, unknown>;
  routineCommands: string[];
  handoff: Record<string, unknown>;
  codexHandoffProtocol?: Record<string, unknown>;
  safety: Record<string, unknown>;
  openQuestions: string[];
}

const CURATED_PROJECTS: ProjectMemoryEntry[] = [
  {
    id: "averray-platform",
    name: "Averray Platform",
    aliases: ["platform", "agent", "averray-agent", "operator app", "backend"],
    repos: ["averray-agent/agent"],
    role: "Primary product platform: app, API, indexer, public site, deploy workflows, and product-proof checks.",
    owner: "Pascal / Averray",
    environments: [
      { name: "production app", url: "https://app.averray.com" },
      { name: "production API", url: "https://api.averray.com" },
      { name: "GitHub repo", url: "https://github.com/averray-agent/agent" },
    ],
    surfaces: [
      { name: "GitHub Actions", purpose: "CI, production deploy, discovery manifest publishing, Hermes PR handoff." },
      { name: "Operator app", purpose: "Human-facing product control plane." },
      { name: "Hermes handoff monitor", purpose: "Private release/handoff observability from the reference-agent stack." },
    ],
    deploy: {
      trigger: "Merge to main after CI and merge queue pass.",
      workflow: "Deploy Production",
      vpsPath: "/srv/agent-stack/app",
      script: "/srv/agent-stack/app/scripts/ops/deploy-production.sh",
      serializedBy: "GitHub Actions concurrency and a VPS flock lock",
      postDeployVerification: "Hermes post-deploy read-only testbed suite",
      knownSecretRotation: "ADMIN_JWT / product-proof worker token can expire and must be rotated outside Hermes.",
    },
    routineCommands: [
      "github status",
      "github brief",
      "handoff monitor",
      "propose merge for averray-agent/agent#<PR>",
      "propose deploy for averray-agent/agent sha <SHA>",
    ],
    handoff: {
      pr: "Hermes PR handoff runs after CI, reviews GitHub metadata/checks/files, runs requested testbed checks, and reports PASS / HUMAN REVIEW / BLOCK.",
      protocol: "Codex builds; Hermes reviews and operates. See docs/CODEX_HANDOFF_PROTOCOL.md.",
      deploy: "Post-deploy verification runs the read-only testbed suite and reports deploy health.",
      mutates: false,
    },
    codexHandoffProtocol: {
      doc: "docs/CODEX_HANDOFF_PROTOCOL.md",
      builder: "Codex",
      reviewerOperator: "Hermes",
      transport: "GitHub Actions -> averray_invoke_agent_task -> handoff monitor / Slack / PR comment",
      prIntents: ["pr_code_review", "pr_handoff"],
      deployIntent: "post_deploy_verification",
      verdicts: {
        PASS: "No blocking or review-gated release signal; continue normal human/merge policy.",
        HUMAN_REVIEW: "Not necessarily broken; a human should inspect the review-gated area before merge.",
        BLOCK: "Do not merge/deploy until fixed or explicitly overridden outside Hermes.",
      },
      codexOnBlock: "Stop, fix the PR or missing evidence, wait for CI, then let Hermes re-run. Do not ask Hermes to override.",
      currentProofChannel: "Hermes Slack, GitHub PR comment, and handoff monitor; email/Resend is optional deferred.",
    },
    safety: {
      secretsInMemory: false,
      autoMergeEnabled: false,
      autoDeployEnabled: false,
      approvalRequiredForAdmin: true,
      contractDeploys: "Never part of normal production deploy; require explicit contract deployment plan.",
    },
    openQuestions: [
      "Document the exact owner/runbook for rotating ADMIN_JWT and product-proof worker tokens.",
      "Add durable hosted app error/log checks beyond current read-only testbed checks.",
    ],
  },
  {
    id: "averray-reference-agent",
    name: "Averray Reference Agent",
    aliases: ["reference agent", "hermes", "command center", "slack operator", "monitor"],
    repos: ["depre-dev/averray-reference-agent"],
    role: "Hermes/Averray reference-agent stack: MCP tools, Slack operator, command center access, handoff monitor, and guarded Wikipedia citation repair.",
    owner: "Pascal / depre-dev",
    environments: [
      { name: "VPS path", path: "/srv/averray-reference-agent" },
      { name: "Command Center", url: "https://command.averray.com" },
      { name: "Handoff Monitor", url: "https://monitor.averray.com" },
      { name: "GitHub repo", url: "https://github.com/depre-dev/averray-reference-agent" },
    ],
    surfaces: [
      { name: "Hermes Workspace", purpose: "Human chat and inspection surface." },
      { name: "Slack operator", purpose: "Daily brief, ops health, GitHub brief, and short operator commands." },
      { name: "Averray MCP", purpose: "Structured tool contract for Hermes, Codex, GitHub Actions, and other agents." },
      { name: "Cloudflare Access", purpose: "Private access to Command Center and monitor without local tunnels." },
    ],
    deploy: {
      trigger: "Manual VPS deploy after PR merges.",
      vpsPath: "/srv/averray-reference-agent",
      command: "git pull --ff-only origin main && docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -f ops/compose.command-center.yml -f ops/compose.cloudflare-access.yml -p avg --profile command-center up -d --build --force-recreate mcp-bundle slack-operator hermes hermes-gateway",
      healthChecks: [
        "curl -sS http://127.0.0.1:8790/health",
        "curl -sS http://127.0.0.1:8790/monitor/events",
      ],
    },
    routineCommands: [
      "daily operator brief",
      "daily github brief",
      "ops health",
      "handoff monitor",
      "project memory",
      "run testbed e2e read-only",
    ],
    handoff: {
      hook: "averray_invoke_agent_task",
      monitor: "averray_handoff_monitor and https://monitor.averray.com",
      protocol: "Codex builds; Hermes reviews and operates. See docs/CODEX_HANDOFF_PROTOCOL.md.",
      mutates: false,
    },
    codexHandoffProtocol: {
      doc: "docs/CODEX_HANDOFF_PROTOCOL.md",
      builder: "Codex",
      reviewerOperator: "Hermes",
      transport: "Averray MCP invocation events, Slack operator, and private monitor.",
      prIntents: ["pr_code_review", "pr_handoff"],
      deployIntent: "post_deploy_verification",
      verdicts: {
        PASS: "Normal release path may continue.",
        HUMAN_REVIEW: "Human owner should inspect the risk signal.",
        BLOCK: "Stop until fixed or explicitly overridden outside Hermes.",
      },
      codexOnBlock: "Fix or add evidence; do not bypass Hermes by retrying blindly.",
      currentProofChannel: "Slack/operator reports and handoff monitor.",
    },
    safety: {
      secretsInMemory: false,
      wikipediaDirectEdits: false,
      projectAdminEnabled: "proposal-only",
      broadAdminDeniedByDefault: true,
    },
    openQuestions: [
      "Decide whether project memory should become user-editable with approval receipts.",
      "Add host-level disk/log/WAL housekeeping as a routine if needed.",
    ],
  },
];

export function getProjectMemory(input: ProjectMemoryInput = {}) {
  const generatedAt = new Date().toISOString();
  const configuredRepos = configuredGithubRepos();
  const projects = mergeConfiguredRepos(CURATED_PROJECTS, configuredRepos);
  const target = selectProject(projects, input.project ?? input.query);

  return {
    schemaVersion: 1,
    kind: "project_admin_memory",
    generatedAt,
    mutates: false,
    scope: {
      source: "curated_repo_memory",
      editableByHermes: false,
      secretsStored: false,
      configuredGithubRepos: configuredRepos,
    },
    ...(target
      ? {
          selectedProject: target,
          relatedProjects: projects
            .filter((project) => project.id !== target.id)
            .map(projectSummary),
        }
      : {
          projects: projects.map(projectSummary),
        }),
    commands: [
      "project memory",
      "known projects",
      "project memory for averray-agent/agent",
      "how do we deploy averray-agent/agent",
    ],
    safety: {
      readOnly: true,
      mutates: false,
      secretsIncluded: false,
      autoAdminEnabled: false,
    },
  };
}

function configuredGithubRepos() {
  const raw = optionalEnv("GITHUB_HELPER_REPOS", "")
    || optionalEnv("GITHUB_DEFAULT_REPO", "")
    || optionalEnv("GITHUB_REPOSITORY", "");
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function mergeConfiguredRepos(projects: ProjectMemoryEntry[], configuredRepos: string[]) {
  const known = new Set(projects.flatMap((project) => project.repos));
  const extras = configuredRepos
    .filter((repo) => !known.has(repo))
    .map<ProjectMemoryEntry>((repo) => ({
      id: repo.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, ""),
      name: repo,
      aliases: [repo],
      repos: [repo],
      role: "GitHub repository configured for read-only Hermes status/briefing, but not yet curated in project memory.",
      owner: "unknown",
      environments: [{ name: "GitHub repo", url: `https://github.com/${repo}` }],
      surfaces: [{ name: "GitHub status", purpose: "Read-only PR, issue, and CI visibility." }],
      deploy: { status: "unknown" },
      routineCommands: [`github status`, `project memory for ${repo}`],
      handoff: { status: "not_configured" },
      safety: { secretsInMemory: false, autoAdminEnabled: false },
      openQuestions: ["Curate deploy URLs, owners, runbooks, and handoff expectations for this repo."],
    }));
  return [...projects, ...extras];
}

function selectProject(projects: ProjectMemoryEntry[], query: string | undefined) {
  const normalized = normalize(extractRepoCandidate(query) ?? query);
  if (!normalized) return undefined;
  return projects.find((project) => {
    const haystack = [
      project.id,
      project.name,
      ...project.aliases,
      ...project.repos,
    ].map(normalize);
    return haystack.some((entry) => entry === normalized || entry.includes(normalized) || normalized.includes(entry));
  });
}

function extractRepoCandidate(value: string | undefined) {
  const match = String(value ?? "").match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  return match?.[0];
}

function projectSummary(project: ProjectMemoryEntry) {
  return {
    id: project.id,
    name: project.name,
    repos: project.repos,
    role: project.role,
    owner: project.owner,
    primaryUrl: primaryUrl(project),
    deployTrigger: stringField(project.deploy, "trigger") ?? stringField(project.deploy, "status") ?? "unknown",
    usefulCommands: project.routineCommands.slice(0, 4),
    openQuestions: project.openQuestions,
  };
}

function primaryUrl(project: ProjectMemoryEntry) {
  for (const environment of project.environments) {
    const url = stringField(environment, "url");
    if (url) return url;
  }
  return null;
}

function normalize(value: string | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

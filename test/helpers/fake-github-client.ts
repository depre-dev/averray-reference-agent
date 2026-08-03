import type {
  GitHubWriteAuthorization,
  PrPayloadGitHubClient,
  RemotePullRequest,
} from "../../services/harness-dispatcher/src/pr-payload-sender.js";
import type { PrPayloadActuationResult } from "../../services/harness-dispatcher/src/pr-payload-actuator.js";

export const FAKE_GITHUB_REPOSITORY = "depre-dev/averray-reference-agent";

export class FakeGitHubClient implements PrPayloadGitHubClient {
  authorization: GitHubWriteAuthorization = {
    identity: "ceremony-app#installation-1001",
    repositorySelection: "selected",
    writeRepositories: [FAKE_GITHUB_REPOSITORY],
    permissions: {
      contents: "write",
      pullRequests: "write",
      extraWriteScopes: [],
    },
  };
  baseRevision: string;
  remoteCalls = 0;
  materializeCalls = 0;
  createCalls = 0;
  crashAfterCreate = false;
  onMaterialize?: () => void;
  readonly pullRequests: RemotePullRequest[] = [];

  constructor(
    baseRevision: string,
    readonly repository = FAKE_GITHUB_REPOSITORY,
  ) {
    this.baseRevision = baseRevision;
  }

  async readWriteAuthorization(): Promise<GitHubWriteAuthorization> {
    this.remoteCalls += 1;
    return structuredClone(this.authorization);
  }

  async readCurrentBase(repository: string, baseRef: string) {
    this.remoteCalls += 1;
    if (repository !== this.repository) {
      throw new Error(`Fake GitHub client refused repository ${repository}`);
    }
    return { ref: baseRef, revision: this.baseRevision };
  }

  async listPullRequestsByHead(repository: string, headRef: string) {
    this.remoteCalls += 1;
    return structuredClone(this.pullRequests.filter(
      (pullRequest) => pullRequest.repository === repository
        && pullRequest.head.ref === headRef,
    ));
  }

  async materializeHead(): Promise<void> {
    this.remoteCalls += 1;
    this.materializeCalls += 1;
    this.onMaterialize?.();
  }

  async openPullRequest(actuation: PrPayloadActuationResult) {
    this.remoteCalls += 1;
    this.createCalls += 1;
    const opened = fakeRemotePullRequest(
      actuation,
      this.pullRequests.length + 1,
    );
    this.pullRequests.push(opened);
    if (this.crashAfterCreate) {
      this.crashAfterCreate = false;
      throw new Error("simulated process loss after remote create");
    }
    return structuredClone(opened);
  }
}

export function fakeRemotePullRequest(
  actuation: PrPayloadActuationResult,
  number: number,
): RemotePullRequest {
  return {
    repository: actuation.payload.repository,
    number,
    state: "open",
    title: actuation.payload.title,
    body: actuation.payload.body,
    base: structuredClone(actuation.payload.base),
    head: {
      ref: actuation.payload.head.ref,
      revision: "e".repeat(40),
      treeSha: actuation.payload.head.treeSha,
    },
  };
}

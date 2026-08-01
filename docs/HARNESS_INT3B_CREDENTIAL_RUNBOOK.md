# INT-3b credential and first-send runbook

INT-3b is an operator-side, single-shot pull-request actuation seam. It consumes
the content-addressed result produced by INT-3a. It is not wired into the agent
container, the production Compose dispatch profile, a model environment, or a
CLI. This implementation does not create, request, install, or use a real
credential and does not perform a real send.

The first target repository and the credential owner remain operator decisions.
Do not provision a credential until the INT-3b refusal ceremony is green and the
operator has selected both.

## Required credential boundary

Use a short-lived GitHub App installation access token. The app installation and
the issued token must both be selected-repository scoped to exactly the one
operator-approved repository. The only write permissions are:

- Contents: write, to create the deterministic `harness/*` head without a force
  push.
- Pull requests: write, to open the PR.
- Metadata: read is GitHub's implicit repository read permission.

No organization-wide repository selection and no additional write permission is
accepted. The sender reads the token's live repository list through GitHub's
[installation repositories endpoint](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).
It binds that response to the permission and repository-selection metadata from
the token-issuance response. GitHub documents that an installation-token response
contains its expiry, permissions, and selected repositories and that installation
tokens expire after one hour in
[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Strip the token field before the issuance metadata enters the sender. The safe
record contains only:

- GitHub App/installation identity;
- `repositorySelection: selected`;
- the one selected `owner/repository`;
- Contents and Pull requests permission levels;
- any additional write permission names (the sender requires this list to be
  empty); and
- expiry, if the operator records it outside the decision contract.

The token itself lives only in the operator-owned sender process's secret store.
It is never a CLI argument, file artifact, decision record, suite summary, log,
model environment, agent container variable, or Compose environment value. The
GitHub App private key and token-minting authority never enter the sender.

## Free pre-flight before the first send

Run the committed INT-3b suite from a clean checkout:

```bash
npm run typecheck
npm test
npm run build
npm run test:int3b
```

Then construct the INT-3a payload and call `preflightPullRequestPayload` from the
operator-owned process with the live client. That function can only:

1. read and validate the issued authorization metadata plus the live installation
   repository list;
2. query GitHub for the deterministic head;
3. read the live base revision; and
4. re-check global and repository HALT.

It has no PR-create operation and must return `ready` (or `adoptable` when the
exact PR already exists). Record identity, repository, selected-repository mode,
permission names, live base SHA, derived head, and result. Never record request
headers or the token.

The send is a separate, single call to `sendPullRequestPayload`. Do not loop or
retry it blindly. A process loss after GitHub accepts the create call is resolved
by one operator re-run: the sender queries the deterministic head, adopts the
existing exact PR, and does not create another.

After the call, record the PR number, head commit SHA, payload artifact hash,
decision record, credential identity/scope, and confirmation that the remote head
tree equals the payload `treeSha`. Merge remains a human action.

## Rotation and revocation

Installation tokens are short-lived. For routine rotation, mint the replacement
outside the sender, scope it to the same single repository and permissions,
capture the safe issuance metadata, replace the operator-process secret, run the
read-only pre-flight, and allow the old token to expire. Do not overlap a send
across token rotation.

For immediate revocation:

1. declare global or repository HALT;
2. stop the operator-side sender process;
3. revoke the current installation token using GitHub's documented
   [revoke installation access token endpoint](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token),
   or remove the repository from the installation when the installation itself is
   in doubt;
4. rotate the GitHub App private key in its separate owner system if that owner
   was compromised; and
5. keep HALT active until the new token's issuance metadata and live repository
   list pass pre-flight.

The sender intentionally has no revocation, app-management, merge, force-push,
close, reopen, comment, branch-protection, or default-branch operation. Those
remain human/operator responsibilities outside the actuation capability.

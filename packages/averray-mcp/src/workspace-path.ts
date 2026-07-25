export const DISPATCH_WORKSPACE_ROOT =
  "/var/lib/harness-dispatcher/workspaces";

/**
 * Changing DISPATCH_WORKSPACE_ROOT or the slug algorithm invalidates every
 * previously approved task hash, so it is a breaking change requiring
 * re-approval.
 */
export function workspacePathForTask(
  workItemId: string,
  taskVersion: number,
): string {
  const slug = workItemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Workspace path requires a non-empty work item slug");
  }

  const target = `${DISPATCH_WORKSPACE_ROOT}/${slug}-v${taskVersion}`;
  if (!target.startsWith(`${DISPATCH_WORKSPACE_ROOT}/`)) {
    throw new Error("Workspace path must remain under the dispatch root");
  }
  return target;
}

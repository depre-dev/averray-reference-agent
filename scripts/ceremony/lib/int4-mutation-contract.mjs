export function assertKnownMutation(suite, mutation, validMutations) {
  if (!mutation || validMutations.includes(mutation)) return;
  throw new Error(
    `${suite}_UNKNOWN_MUTATION name=${mutation} valid=${validMutations.join(",")}`,
  );
}

export function assertMutationApplied(suite, mutation, output) {
  if (!mutation) return;
  const marker = `${suite}_MUTATION_APPLIED=${mutation}`;
  if (output.includes(marker)) return;
  throw new Error(
    `${suite}_MUTATION_NOT_APPLIED name=${mutation} expected=${marker}`,
  );
}

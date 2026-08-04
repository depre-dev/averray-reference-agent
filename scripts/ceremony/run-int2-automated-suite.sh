#!/usr/bin/env bash
# Headless INT-2 mechanism gate: real production dispatcher, two real Postgres
# databases, the pinned Harness, and Docker-isolated scripted runs.
set -euo pipefail

_int2_repo="$(cd "$(dirname "$0")/../.." && pwd)"
_int2_root="$(mktemp -d -t int2-automated.XXXXXX)"
_int2_suffix="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
_int2_harness_db="int2-suite-harness-${_int2_suffix}"
_int2_reference_db="int2-suite-reference-${_int2_suffix}"
_int2_evidence="${INT2_SUITE_EVIDENCE_DIR:-$_int2_root/evidence}"
_int2_marker="$_int2_evidence/executed-count.txt"
_int2_bootstrap_log="$_int2_evidence/bootstrap.log"
_int2_started="$(date +%s)"
_int2_docker_shared_root="${HOME:?}/.agent-runtime"
_int2_git_probe=""
# Bookkeeping the cleanup trap reaps from. Both live under the temp root, not
# the evidence directory: they are transient, and CI uploads the evidence.
_int2_worker_pidfile="$_int2_root/worker-pids.txt"
_int2_run_containers_before="$_int2_root/run-containers-before.txt"
# The workspace half of the same leak family (#625): the Harness Docker tier
# roots run workspaces under a persistent shared directory, and a run that
# dies before destroy() leaves its agent-runtime-<run_id> directory behind.
# INT2_WORKSPACE_ROOT exists for the unit tests; operators never set it.
_int2_workspaces_before="$_int2_root/workspaces-before.txt"
_int2_workspace_root="${INT2_WORKSPACE_ROOT:-$HOME/.agent-runtime/environments}"
_int2_dep_source="$_int2_root/dependency-source"

# shellcheck source=scripts/ceremony/lib/int2-reap.sh
source "$_int2_repo/scripts/ceremony/lib/int2-reap.sh"

_int2_cleanup() {
  _int2_exit="$?"
  printf '%s\n' "INT2_SUITE_EXIT_CODE=$_int2_exit" \
    >> "$_int2_bootstrap_log" 2>/dev/null || true
  # First: stop the workers this run spawned. Ahead of the postmortem so
  # nothing is still writing to the databases it is about to read, and ahead of
  # everything else because a vitest crash never reaches the suite's own
  # afterAll — which is how one of these came to outlive its own temp root by
  # three days. Reaping is by recorded pid with re-verified identity; see
  # lib/int2-reap.sh for why `pkill -f "harness worker"` is not an option.
  int2_reap_workers \
    "$_int2_worker_pidfile" \
    "${HARNESS_BIN:-} worker" \
    "$_int2_bootstrap_log" || true
  # On any failure, preserve why the databases were unhappy before removing
  # them. Containers outlive their crash on purpose (no --rm) so this works.
  if [ "$_int2_exit" -ne 0 ]; then
    for _int2_dead in "$_int2_harness_db" "$_int2_reference_db"; do
      docker inspect "$_int2_dead" >/dev/null 2>&1 || continue
      printf '%s\n' "INT2_DB_POSTMORTEM name=$_int2_dead" \
        >> "$_int2_bootstrap_log" 2>/dev/null || true
      docker inspect \
        --format 'state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' \
        "$_int2_dead" >> "$_int2_bootstrap_log" 2>&1 || true
      docker logs --tail 50 "$_int2_dead" \
        >> "$_int2_bootstrap_log" 2>&1 || true
    done
  fi
  # The workers are gone, so no new run container can appear underneath this.
  int2_reap_run_containers \
    "$_int2_run_containers_before" "$_int2_bootstrap_log" || true
  # After the containers, so no removed container's bind mount still points
  # at a directory being deleted (#625 — the workspace half of the reap).
  int2_reap_workspaces \
    "$_int2_workspaces_before" "$_int2_workspace_root" "$_int2_bootstrap_log" \
    || true
  docker rm --force "$_int2_harness_db" "$_int2_reference_db" \
    >/dev/null 2>&1 || true
  case "$_int2_git_probe" in
    "$_int2_docker_shared_root"/int2-pilot-git-probe.*)
      rm -rf "$_int2_git_probe"
      ;;
  esac
  rm -rf "$_int2_root"
}
trap _int2_cleanup EXIT INT TERM

for _int2_command in docker git node npm uv; do
  command -v "$_int2_command" >/dev/null 2>&1 \
    || { echo "INT-2 suite requires $_int2_command" >&2; exit 2; }
done
mkdir -p "$_int2_evidence"
printf '%s\n' \
  "INT2_SUITE_BOOTSTRAP_STARTED pin=e21c831ddfa3d80c4c1113d42dae4eba7db67079" \
  > "$_int2_bootstrap_log"

export HARNESS_CHECKOUT="${HARNESS_CHECKOUT:-$_int2_root/agent-harness}"
_int2_pin="e21c831ddfa3d80c4c1113d42dae4eba7db67079"
# shellcheck source=scripts/ceremony/lib/int2-harness-checkout.sh
source "$_int2_repo/scripts/ceremony/lib/int2-harness-checkout.sh"
int2_checkout_harness "$HARNESS_CHECKOUT" "$_int2_pin" "$_int2_bootstrap_log"
test -z "$(git -C "$HARNESS_CHECKOUT" status --porcelain)" \
  || {
    echo "INT2_HARNESS_CHECKOUT_DIRTY: the private Harness checkout is not clean" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 23
  }
git -C "$HARNESS_CHECKOUT" checkout --quiet --detach "$_int2_pin" \
  2>> "$_int2_bootstrap_log" \
  || {
    echo "INT2_HARNESS_PIN_UNAVAILABLE: checkout does not contain the required pinned revision" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 24
  }
test "$(git -C "$HARNESS_CHECKOUT" rev-parse HEAD)" = "$_int2_pin" \
  || {
    echo "INT2_HARNESS_PIN_MISMATCH: checkout did not resolve to the required revision" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 25
  }
printf '%s\n' "INT2_HARNESS_PIN_VERIFIED pin=$_int2_pin" \
  >> "$_int2_bootstrap_log"

# --- database bring-up -------------------------------------------------------
# Every failure below names itself, like the checkout failures above it.
#
# It did not always. A CI failure exited 1 in this region having printed
# NOTHING: `pg_isready` reports on STDOUT, so `>/dev/null` swallowed the reason
# entirely, and a twelve-second failure was undiagnosable from a full job log.
# The bootstrap log jumped straight from INT2_HARNESS_PIN_VERIFIED to
# INT2_SUITE_EXIT_CODE=1.
#
# Containers are NOT started with --rm: a crashed container must survive long
# enough for `docker logs` to explain why. Cleanup removes them.

_int2_db_diagnostics() {
  printf '%s\n' "INT2_DB_DIAGNOSTICS name=$1" >> "$_int2_bootstrap_log"
  docker inspect \
    --format 'state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' \
    "$1" >> "$_int2_bootstrap_log" 2>&1 || true
  docker logs --tail 50 "$1" >> "$_int2_bootstrap_log" 2>&1 || true
}

_int2_start_db() {
  # $1 container name, $2 database name, $3 image
  docker run --detach --name "$1" \
    --publish 127.0.0.1::5432 \
    --env POSTGRES_PASSWORD=int2-suite \
    --env POSTGRES_DB="$2" \
    "$3" >/dev/null 2>>"$_int2_bootstrap_log" \
    || {
      echo "INT2_DB_START_FAILED: $1 ($3) did not start" \
        | tee -a "$_int2_bootstrap_log" >&2
      exit 31
    }
}

_int2_wait_db() {
  # $1 container name, $2 database name.
  #
  # Probes over TCP with a real authenticated query, because that is what the
  # suite itself does. `pg_isready` with no -h probes the UNIX SOCKET, which
  # answers "accepting connections" while initdb's temporary server is up —
  # before the real TCP listener exists. A host-side TCP connect is no better:
  # docker's port proxy accepts connections before postgres is listening at all.
  # Only an authenticated query proves the database is actually usable.
  for _int2_i in $(seq 1 60); do
    if docker exec --env PGPASSWORD=int2-suite "$1" \
        psql -h 127.0.0.1 -U postgres -d "$2" -tAc 'select 1' \
        >/dev/null 2>&1; then
      printf '%s\n' "INT2_DB_READY name=$1 after=${_int2_i}s" \
        >> "$_int2_bootstrap_log"
      return 0
    fi
    sleep 1
  done
  echo "INT2_DB_NEVER_READY: $1 did not answer a TCP query within 60s" \
    | tee -a "$_int2_bootstrap_log" >&2
  _int2_db_diagnostics "$1"
  exit 32
}

# Sets _int2_port_value. Deliberately NOT called in a command substitution:
# `exit` inside `$( )` leaves only the subshell, so a failure there would be
# swallowed and the caller would continue with an empty port.
_int2_db_port() {
  # `docker port` EXITS 1 when nothing is published, so without the `|| :=""`
  # fallback `set -e` aborts on this assignment and the named guard below is
  # unreachable — a guard that cannot fire. Verified by provoking it.
  _int2_port_value="$(
    docker port "$1" 5432/tcp 2>>"$_int2_bootstrap_log" | sed -n '1s/.*://p'
  )" || _int2_port_value=""
  case "$_int2_port_value" in
    '' | *[!0-9]*)
      echo "INT2_DB_PORT_UNMAPPED: $1 published no usable 5432/tcp port" \
        | tee -a "$_int2_bootstrap_log" >&2
      _int2_db_diagnostics "$1"
      exit 33
      ;;
  esac
}

_int2_start_db "$_int2_harness_db"   harness_suite   postgres:18
_int2_start_db "$_int2_reference_db" reference_suite postgres:16-alpine
_int2_wait_db  "$_int2_harness_db"   harness_suite
_int2_wait_db  "$_int2_reference_db" reference_suite

_int2_db_port "$_int2_harness_db"
_int2_harness_port="$_int2_port_value"
_int2_db_port "$_int2_reference_db"
_int2_reference_port="$_int2_port_value"
export HARNESS_TEST_DATABASE_URL="postgresql://postgres:int2-suite@127.0.0.1:${_int2_harness_port}/harness_suite"
export DISPATCH_TEST_DATABASE_URL="postgresql://postgres:int2-suite@127.0.0.1:${_int2_reference_port}/reference_suite"

(
  cd "$HARNESS_CHECKOUT"
  uv sync --frozen
  HARNESS_DATABASE_URL="$HARNESS_TEST_DATABASE_URL" \
    uv run harness db migrate
)
export HARNESS_BIN="$HARNESS_CHECKOUT/.venv/bin/harness"
"$HARNESS_BIN" --help >/dev/null
printf '%s\n' "INT2_HARNESS_RUNTIME_READY" >> "$_int2_bootstrap_log"

for _int2_migration in "$_int2_repo"/ops/migrations/*.sql; do
  docker exec -i "$_int2_reference_db" \
    psql -U postgres -d reference_suite \
      --set ON_ERROR_STOP=1 -q < "$_int2_migration" >/dev/null
done

# The task-family fixtures are pinned to an older repository revision whose
# package-lock differs from current main. The pilot image must carry the exact
# offline toolchain for that immutable base; dependencies from current main
# would make the environment probe pass against a different dependency graph.
_int2_fixture_base="$(
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const fixture = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.stdout.write(fixture.repository.baseRevision);
  ' "$_int2_repo/test/fixtures/agent-integration/ceremony/add-unit-test.json"
)"
git clone --quiet --local --no-hardlinks "$_int2_repo" "$_int2_dep_source"
git -C "$_int2_dep_source" checkout --quiet --detach "$_int2_fixture_base"
test "$(git -C "$_int2_dep_source" rev-parse HEAD)" = "$_int2_fixture_base" \
  || {
    echo "INT2_TOOLCHAIN_BASE_MISMATCH: image source is not at the fixture base" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 27
  }

_int2_image_tag="reference-agent-pilot:int2-${_int2_suffix}"
docker build --quiet -f "$_int2_repo/ops/Dockerfile.pilot" \
  -t "$_int2_image_tag" "$_int2_dep_source" >/dev/null
export INT2_PILOT_IMAGE="$(
  docker image inspect --format '{{.Id}}' "$_int2_image_tag"
)"
mkdir -p "$_int2_docker_shared_root"
_int2_git_probe="$(
  mktemp -d "$_int2_docker_shared_root/int2-pilot-git-probe.XXXXXX"
)"
git -C "$_int2_git_probe" init --quiet
printf '%s\n' "INT-2 pilot Git ownership probe" \
  > "$_int2_git_probe/tracked.txt"
git -C "$_int2_git_probe" add tracked.txt
git -C "$_int2_git_probe" \
  -c user.name=int2-suite \
  -c user.email=int2-suite.invalid \
  commit --quiet -m "INT-2 pilot Git ownership probe"
docker run --rm --network none \
  --user "$(id -u):$(id -g)" \
  --volume "$_int2_git_probe:/workspace" \
  --workdir /workspace \
  "$INT2_PILOT_IMAGE" \
  /bin/sh -lc \
    'test "$(git config --system --get-all safe.directory)" = "/workspace" && git diff --check && /node_modules/.bin/tsc --version && /node_modules/.bin/vitest --version && mkdir -p .int2-owner-probe/nested && touch .int2-owner-probe/nested/compiled.js' \
  >> "$_int2_bootstrap_log" 2>&1 \
  || {
    echo "INT2_PILOT_ENVIRONMENT_FAILED: pilot cannot run Git and the pinned toolchain in the mounted workspace" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 26
  }
_int2_owner_probe="$_int2_git_probe/.int2-owner-probe"
if ! chmod -R u+w "$_int2_owner_probe" 2>/dev/null \
  || ! rm -rf "$_int2_owner_probe" 2>/dev/null; then
  echo "INT2_PILOT_WORKSPACE_OWNERSHIP_FAILED: pilot outputs are not removable by the workspace owner" \
    | tee -a "$_int2_bootstrap_log" >&2
  exit 29
fi
printf '%s\n' "INT2_PILOT_GIT_OWNERSHIP_VERIFIED" \
  >> "$_int2_bootstrap_log"
printf '%s\n' "INT2_PILOT_WORKSPACE_OWNERSHIP_VERIFIED" \
  >> "$_int2_bootstrap_log"
printf '%s\n' \
  "INT2_PILOT_ENVIRONMENT_VERIFIED base=$_int2_fixture_base" \
  >> "$_int2_bootstrap_log"

export INT2_SUITE_REQUIRED=1
export INT2_REPOSITORY_ROOT="$_int2_repo"
export INT2_SUITE_EVIDENCE_DIR="$_int2_evidence"
export INT2_SUITE_EXECUTION_MARKER="$_int2_marker"
# The suite spawns its Harness workers from inside vitest, so the trap cannot
# see their pids unless the tests hand them over. Each worker appends its own
# the instant it exists.
export INT2_SUITE_WORKER_PIDFILE="$_int2_worker_pidfile"

# Everything from here on is "during the run": nothing above this line starts a
# Harness run, so anything named harness-run-* that exists now belongs to
# somebody else and the trap must not touch it. Recorded immediately before the
# cases start so the window is as narrow as it can be made.
int2_reap_snapshot_run_containers "$_int2_run_containers_before" \
  || {
    echo "INT2_RUN_CONTAINER_SNAPSHOT_FAILED: cannot list existing harness-run-* containers" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 34
  }
printf '%s\n' "INT2_RUN_CONTAINER_SNAPSHOT spared=$(
  grep -c . "$_int2_run_containers_before" 2>/dev/null || echo 0
)" >> "$_int2_bootstrap_log"
# The workspace snapshot shares the container snapshot's boundary: everything
# under the root right now is somebody else's — possibly an operator's live
# ceremony workspace — and the trap must not touch it.
int2_reap_snapshot_workspaces "$_int2_workspaces_before" "$_int2_workspace_root" \
  || {
    echo "INT2_WORKSPACE_SNAPSHOT_FAILED: cannot list existing agent-runtime-* workspaces" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 35
  }
printf '%s\n' "INT2_WORKSPACE_SNAPSHOT spared=$(
  grep -c . "$_int2_workspaces_before" 2>/dev/null || echo 0
)" >> "$_int2_bootstrap_log"

printf '%s\n' "INT2_CASES_STARTED expected=14" >> "$_int2_bootstrap_log"
(
  cd "$_int2_repo"
  npm run build
  npx vitest run test/integration/int2-automated-suite.test.ts \
    --reporter=verbose
)

_int2_executed="$(tr -d '[:space:]' < "$_int2_marker")"
test "$_int2_executed" = "14" \
  || {
    echo "INT-2 suite executed $_int2_executed cases; expected 14" >&2
    exit 1
  }
_int2_elapsed="$(( $(date +%s) - _int2_started ))"
printf '%s\n' "$_int2_elapsed" > "$_int2_evidence/wall-time-seconds.txt"
printf '%s\n' "INT2_CASES_COMPLETED executed=$_int2_executed elapsed=$_int2_elapsed" \
  >> "$_int2_bootstrap_log"
echo "INT-2 automated suite: $_int2_executed cases executed in ${_int2_elapsed}s"

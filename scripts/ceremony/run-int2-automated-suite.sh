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

_int2_cleanup() {
  _int2_exit="$?"
  printf '%s\n' "INT2_SUITE_EXIT_CODE=$_int2_exit" \
    >> "$_int2_bootstrap_log" 2>/dev/null || true
  docker stop "$_int2_harness_db" "$_int2_reference_db" \
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
  "INT2_SUITE_BOOTSTRAP_STARTED pin=0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2" \
  > "$_int2_bootstrap_log"

export HARNESS_CHECKOUT="${HARNESS_CHECKOUT:-$_int2_root/agent-harness}"
_int2_pin="0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2"
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

docker run --rm --detach --name "$_int2_harness_db" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_PASSWORD=int2-suite \
  --env POSTGRES_DB=harness_suite \
  postgres:18 >/dev/null
docker run --rm --detach --name "$_int2_reference_db" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_PASSWORD=int2-suite \
  --env POSTGRES_DB=reference_suite \
  postgres:16-alpine >/dev/null

for _int2_i in $(seq 1 60); do
  docker exec "$_int2_harness_db" \
    pg_isready -U postgres -d harness_suite >/dev/null 2>&1 && break
  sleep 1
done
for _int2_i in $(seq 1 60); do
  docker exec "$_int2_reference_db" \
    pg_isready -U postgres -d reference_suite >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$_int2_harness_db" \
  pg_isready -U postgres -d harness_suite >/dev/null
docker exec "$_int2_reference_db" \
  pg_isready -U postgres -d reference_suite >/dev/null

_int2_harness_port="$(
  docker port "$_int2_harness_db" 5432/tcp | sed -n '1s/.*://p'
)"
_int2_reference_port="$(
  docker port "$_int2_reference_db" 5432/tcp | sed -n '1s/.*://p'
)"
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

_int2_image_tag="reference-agent-pilot:int2-${_int2_suffix}"
docker build --quiet -f "$_int2_repo/ops/Dockerfile.pilot" \
  -t "$_int2_image_tag" "$_int2_repo" >/dev/null
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
  --volume "$_int2_git_probe:/workspace" \
  --workdir /workspace \
  "$INT2_PILOT_IMAGE" \
  /bin/sh -lc \
    'test "$(git config --system --get-all safe.directory)" = "/workspace" && git diff --check' \
  >> "$_int2_bootstrap_log" 2>&1 \
  || {
    echo "INT2_PILOT_GIT_OWNERSHIP_FAILED: pilot cannot run Git in the mounted workspace" \
      | tee -a "$_int2_bootstrap_log" >&2
    exit 26
  }
printf '%s\n' "INT2_PILOT_GIT_OWNERSHIP_VERIFIED" \
  >> "$_int2_bootstrap_log"

export INT2_SUITE_REQUIRED=1
export INT2_REPOSITORY_ROOT="$_int2_repo"
export INT2_SUITE_EVIDENCE_DIR="$_int2_evidence"
export INT2_SUITE_EXECUTION_MARKER="$_int2_marker"

printf '%s\n' "INT2_CASES_STARTED expected=9" >> "$_int2_bootstrap_log"
(
  cd "$_int2_repo"
  npm run build
  npx vitest run test/integration/int2-automated-suite.test.ts \
    --reporter=verbose
)

_int2_executed="$(tr -d '[:space:]' < "$_int2_marker")"
test "$_int2_executed" = "9" \
  || {
    echo "INT-2 suite executed $_int2_executed cases; expected 9" >&2
    exit 1
  }
_int2_elapsed="$(( $(date +%s) - _int2_started ))"
printf '%s\n' "$_int2_elapsed" > "$_int2_evidence/wall-time-seconds.txt"
printf '%s\n' "INT2_CASES_COMPLETED executed=$_int2_executed elapsed=$_int2_elapsed" \
  >> "$_int2_bootstrap_log"
echo "INT-2 automated suite: $_int2_executed cases executed in ${_int2_elapsed}s"

#!/usr/bin/env bash
# Reaping for the INT-2 automated suite: the Harness worker processes it spawns
# and the per-run Docker containers those workers create.
#
# The suite's EXIT trap used to remove its temp root and its two Postgres
# containers and stop there. Both of the things below outlived it:
#
#   * A worker survived with PPID 1 for nearly three days, its command line
#     still pointing at a temp root the same trap had already deleted. It was
#     found by the §3 ceremony's "assert no worker is already running"
#     preflight, which it blocked, during a live paid run.
#   * harness-run-* containers accumulated one per run — the Harness Docker
#     environment tier starts them with a durable name and no --rm, on purpose,
#     so a crashed run can still be inspected.
#
# Kept in its own file so test/unit/int2-ceremony-scripts.test.ts can drive it
# directly, with fake workers and a fake docker, and prove the safety property
# below without standing up databases, a Harness checkout, or Docker. Every
# function takes what it needs as arguments and reads no suite global.
#
# THE SAFETY PROPERTY. Reaping is by RECORDED PID, never by pattern. The
# obvious fix, `pkill -f "harness worker"`, would kill an operator's own
# ceremony worker — the very process the leak was obstructing. Worse, a pid
# recorded hours earlier is not by itself trustworthy either: the worker may
# have exited and the OS may have recycled its pid onto something unrelated.
# So every pid is re-identified against THIS run's Harness binary in the
# instant before it is signalled, and a pid that no longer answers to that
# identity is left alone.

# macOS mktemp hands back /var/folders/... while ps reports the same path as
# /private/var/folders/..., so comparing the two literally never matches.
# Applied to both sides, this makes them comparable. On Linux there is no
# /private prefix to strip and both sides pass through unchanged.
int2_reap_unprivate() {
  case "$1" in
    /private/*) printf '%s' "${1#/private}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# $1 pid, $2 the command fragment that identifies this run's workers — the
# suite passes "$HARNESS_BIN worker", whose Harness path is unique per run
# because it lives under the run's own mktemp root.
#
# A substring test rather than a prefix test because the pid's command line
# takes either of two shapes: `<harness> worker` when the shim is exec'd
# directly, or `<python> <harness> worker` once the kernel has resolved the
# console script's shebang. Both contain the fragment; a worker rooted
# anywhere else contains neither.
int2_reap_is_tracked_worker() {
  # The fragment must be an absolute path, which is the one thing that makes it
  # discriminating. The trap composes it as "$HARNESS_BIN worker", and
  # HARNESS_BIN is not exported until well into the run: an unset one would
  # degrade the fragment to " worker" and match every worker on the machine.
  # Nothing reaches here with a pidfile that early today — but a fragment that
  # matches everything is precisely the outcome this file exists to prevent, so
  # it is refused at the door rather than left to depend on ordering.
  case "${2:-}" in /?*) ;; *) return 1 ;; esac
  _int2_reap_seen="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  [ -n "$_int2_reap_seen" ] || return 1
  case "$(int2_reap_unprivate "$_int2_reap_seen")" in
    *"$(int2_reap_unprivate "$2")"*) return 0 ;;
  esac
  return 1
}

# Signal one worker's whole process group when it leads one — the suite spawns
# workers detached, so it does — and fall back to the bare pid when it does
# not. The group form takes anything the worker itself spawned with it.
# $1 signal name, $2 pid.
int2_reap_signal() {
  if kill -s "$1" -- "-$2" 2>/dev/null; then
    return 0
  fi
  if kill -s "$1" -- "$2" 2>/dev/null; then
    return 0
  fi
  return 1
}

# $1 pidfile written by the suite's workers, $2 identifying command fragment,
# $3 log path. TERM first, then KILL for anything still answering to the
# tracked identity five seconds later.
int2_reap_workers() {
  _int2_reap_pidfile="${1:-}"
  _int2_reap_expect="${2:-}"
  _int2_reap_log="${3:-/dev/null}"
  [ -n "$_int2_reap_pidfile" ] && [ -f "$_int2_reap_pidfile" ] || return 0

  _int2_reap_signalled=""
  while IFS= read -r _int2_reap_pid || [ -n "$_int2_reap_pid" ]; do
    case "$_int2_reap_pid" in '' | *[!0-9]*) continue ;; esac
    int2_reap_is_tracked_worker "$_int2_reap_pid" "$_int2_reap_expect" \
      || continue
    int2_reap_signal TERM "$_int2_reap_pid" || continue
    _int2_reap_signalled="$_int2_reap_signalled $_int2_reap_pid"
    printf '%s\n' "INT2_WORKER_REAPED pid=$_int2_reap_pid signal=TERM" \
      >> "$_int2_reap_log" 2>/dev/null || true
  done < "$_int2_reap_pidfile"
  [ -n "$_int2_reap_signalled" ] || return 0

  _int2_reap_alive=""
  for _int2_reap_try in 1 2 3 4 5; do
    _int2_reap_alive=""
    for _int2_reap_pid in $_int2_reap_signalled; do
      if int2_reap_is_tracked_worker "$_int2_reap_pid" "$_int2_reap_expect"
      then
        _int2_reap_alive="$_int2_reap_alive $_int2_reap_pid"
      fi
    done
    [ -n "$_int2_reap_alive" ] || return 0
    sleep 1
  done
  for _int2_reap_pid in $_int2_reap_alive; do
    int2_reap_signal KILL "$_int2_reap_pid" || true
    printf '%s\n' "INT2_WORKER_REAPED pid=$_int2_reap_pid signal=KILL" \
      >> "$_int2_reap_log" 2>/dev/null || true
  done
  return 0
}

# Record the harness-run-* containers that exist BEFORE the run, into $1.
# Fails without creating the file when Docker cannot be listed, which is what
# makes the reap below fail safe: no snapshot, nothing removed.
int2_reap_snapshot_run_containers() {
  _int2_reap_existing="$(
    docker ps --all --filter 'name=^harness-run-' --format '{{.Names}}' 2>/dev/null
  )" || return 1
  printf '%s\n' "$_int2_reap_existing" > "$1"
}

# $1 the snapshot file, $2 log path. Removes every harness-run-* container that
# was not in the snapshot.
#
# Why a snapshot diff and not a list of ids the suite can compute: a container
# is named for the Harness run that created it, and only top-level runs get a
# row in the runs table. Child and verification runs derive their own ids
# (uuid5 of the parent, and `<child>-check-<cycle>`), so they are unknowable up
# front and unrecoverable afterwards. What the suite CAN state exactly is which
# containers it did not create — and everything in the snapshot is spared,
# including the days-old leaks this fix does not retroactively own and any
# container belonging to an operator's already-running ceremony.
#
# A missing or unreadable snapshot removes nothing at all. Deleting every
# harness-run-* container because the suite failed before it could look is the
# one outcome worse than leaking.
int2_reap_run_containers() {
  _int2_reap_before="${1:-}"
  _int2_reap_log="${2:-/dev/null}"
  [ -n "$_int2_reap_before" ] && [ -f "$_int2_reap_before" ] || return 0
  _int2_reap_now="$(
    docker ps --all --filter 'name=^harness-run-' --format '{{.Names}}' 2>/dev/null
  )" || return 0

  for _int2_reap_name in $_int2_reap_now; do
    case "$_int2_reap_name" in harness-run-?*) ;; *) continue ;; esac
    if grep -qxF "$_int2_reap_name" "$_int2_reap_before" 2>/dev/null; then
      continue
    fi
    docker rm --force "$_int2_reap_name" >/dev/null 2>&1 || continue
    printf '%s\n' "INT2_RUN_CONTAINER_REAPED name=$_int2_reap_name" \
      >> "$_int2_reap_log" 2>/dev/null || true
  done
  return 0
}

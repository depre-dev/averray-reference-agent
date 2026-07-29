#!/usr/bin/env bash

# Checkout the private pinned Harness without leaking its read-only deploy key
# to the worker or later test processes. The caller remains responsible for
# verifying the checkout's cleanliness and exact revision.
int2_checkout_harness() {
  if [ "$#" -ne 3 ]; then
    echo "INT2_HARNESS_CHECKOUT_ARGUMENTS_INVALID: expected checkout, pin, and evidence log" >&2
    return 2
  fi

  _int2_checkout_target="$1"
  _int2_checkout_pin="$2"
  _int2_checkout_log="$3"
  _int2_checkout_key="${INT2_HARNESS_DEPLOY_KEY:-}"

  if [ -d "$_int2_checkout_target/.git" ]; then
    unset INT2_HARNESS_DEPLOY_KEY
    printf '%s\n' \
      "INT2_HARNESS_CHECKOUT_REUSED target=$_int2_checkout_target pin=$_int2_checkout_pin" \
      >> "$_int2_checkout_log"
    return 0
  fi

  if [ "${CI:-}" = "true" ] && [ -z "$_int2_checkout_key" ]; then
    unset INT2_HARNESS_DEPLOY_KEY
    echo "INT2_HARNESS_DEPLOY_KEY_MISSING: CI requires the read-only private Harness deploy key" \
      | tee -a "$_int2_checkout_log" >&2
    return 20
  fi

  if [ -n "$_int2_checkout_key" ]; then
    _int2_checkout_ssh_root="$(dirname "$_int2_checkout_target")/harness-ssh"
    _int2_checkout_key_path="$_int2_checkout_ssh_root/deploy-key"
    _int2_checkout_known_hosts="$_int2_checkout_ssh_root/known-hosts"
    mkdir -p "$_int2_checkout_ssh_root"
    printf '%s\n' "$_int2_checkout_key" > "$_int2_checkout_key_path"
    # GitHub's published Ed25519 host key. Strict verification avoids trusting
    # an unauthenticated ssh-keyscan result in the mechanism gate.
    printf '%s\n' \
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" \
      > "$_int2_checkout_known_hosts"
    chmod 600 "$_int2_checkout_key_path" "$_int2_checkout_known_hosts"
    _int2_checkout_key=""
    unset INT2_HARNESS_DEPLOY_KEY
    _int2_checkout_ssh_command="ssh -i $_int2_checkout_key_path -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$_int2_checkout_known_hosts"
    if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$_int2_checkout_ssh_command" \
      git clone --quiet git@github.com:averray-agent/agent-harness.git \
        "$_int2_checkout_target" 2>> "$_int2_checkout_log"; then
      echo "INT2_HARNESS_CHECKOUT_FAILED: authenticated SSH clone of the private pinned Harness failed" \
        | tee -a "$_int2_checkout_log" >&2
      return 21
    fi
    printf '%s\n' \
      "INT2_HARNESS_CHECKOUT_AUTHENTICATED method=read-only-deploy-key pin=$_int2_checkout_pin" \
      >> "$_int2_checkout_log"
    return 0
  fi

  unset INT2_HARNESS_DEPLOY_KEY
  if ! GIT_TERMINAL_PROMPT=0 \
    git clone --quiet https://github.com/averray-agent/agent-harness.git \
      "$_int2_checkout_target" 2>> "$_int2_checkout_log"; then
    echo "INT2_HARNESS_CHECKOUT_FAILED: private Harness checkout unavailable; set HARNESS_CHECKOUT or INT2_HARNESS_DEPLOY_KEY" \
      | tee -a "$_int2_checkout_log" >&2
    return 22
  fi
  printf '%s\n' \
    "INT2_HARNESS_CHECKOUT_AUTHENTICATED method=developer-git-credentials pin=$_int2_checkout_pin" \
    >> "$_int2_checkout_log"
}

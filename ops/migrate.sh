#!/usr/bin/env bash
set -euo pipefail

psql "${DATABASE_URL:?DATABASE_URL is required}" -f /migrations/001_init.sql
psql "${DATABASE_URL:?DATABASE_URL is required}" -f /migrations/002_agent_tasks.sql
psql "${DATABASE_URL:?DATABASE_URL is required}" -f /migrations/003_dispatch_claims_outbox_decisions.sql
psql "${DATABASE_URL:?DATABASE_URL is required}" -f /migrations/004_dispatch_quarantines.sql

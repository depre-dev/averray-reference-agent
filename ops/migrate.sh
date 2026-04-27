#!/usr/bin/env bash
set -euo pipefail

psql "${DATABASE_URL:?DATABASE_URL is required}" -f /migrations/001_init.sql


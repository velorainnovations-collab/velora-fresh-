#!/usr/bin/env bash
# ============================================================
# Velora Fresh — run the database test suites
#
#   supabase/run_tests.sh [psql-args...]
#
# Defaults to a local server on port 5433. Each suite gets a freshly
# built database: both of them write, so running one after the other in
# the same database changes the counts the other asserts on.
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "$#" -gt 0 ]; then
  PSQL=(psql "$@")
else
  PSQL=(psql -h /tmp -p 5433 -U postgres)
fi

run_suite() {
  local db="$1" suite="$2"
  shift 2
  "${PSQL[@]}" -q -c "drop database if exists $db" -c "create database $db" >/dev/null 2>&1
  for f in "$@"; do
    "${PSQL[@]}" -d "$db" -v ON_ERROR_STOP=1 -q -f "$HERE/$f.sql" >/dev/null 2>&1
  done
  echo "--- $suite ---"
  # a failing suite exits non-zero on purpose; show its result either way
  "${PSQL[@]}" -d "$db" -q -f "$HERE/$suite.sql" 2>&1 \
    | { grep -E "FAIL|passed|^ +[0-9]+ \| +[0-9]+" || true; } | tail -3
  "${PSQL[@]}" -q -c "drop database if exists $db" >/dev/null 2>&1
}

run_suite vf_sec  test_security 01_schema 02_security 03_seed 06_users
run_suite vf_user test_users    01_schema 02_security 03_seed 06_users

# the catalogue and production seed must load, and load twice
echo "--- catalogue and production seed ---"
"${PSQL[@]}" -q -c "drop database if exists vf_cat" -c "create database vf_cat" >/dev/null 2>&1
for f in 01_schema 02_security 04_catalogue 05_production 04_catalogue 05_production; do
  "${PSQL[@]}" -d vf_cat -v ON_ERROR_STOP=1 -q -f "$HERE/$f.sql" >/dev/null 2>&1
done
"${PSQL[@]}" -d vf_cat -tAc "select (select count(*) from products)||' products, '||
  (select count(*) from vendor_groups)||' groups, '||
  (select count(*) from shops)||' shops after loading twice'"
"${PSQL[@]}" -q -c "drop database if exists vf_cat" >/dev/null 2>&1

#!/usr/bin/env bash
# One-time local setup: creates the two database roles and the dev database.
# Run as a Postgres superuser (as root it switches to the postgres user).
# These are local-only passwords; real ones come from environment variables at go-live.
set -euo pipefail
psql_su() { if [ "$(id -u)" = 0 ]; then su postgres -c "psql -v ON_ERROR_STOP=1 -q"; else psql -v ON_ERROR_STOP=1 -q; fi; }

psql_su <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fb_owner') THEN
    CREATE ROLE fb_owner LOGIN CREATEDB PASSWORD 'fb_owner_local';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'web_user') THEN
    CREATE ROLE web_user LOGIN PASSWORD 'web_user_local';
  END IF;
END $$;
SELECT 'CREATE DATABASE form_board OWNER fb_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'form_board')\gexec
SQL
echo "Local roles and the form_board database are ready."

#!/bin/bash
# REQ-UI-016 — first-run bootstrap for Superset: schema, admin user, roles, then serve.
set -euo pipefail
pip install --quiet --no-cache-dir clickhouse-connect psycopg2-binary >/dev/null 2>&1 || true
superset db upgrade
superset fab create-admin --username "$ADMIN_USERNAME" --firstname OpenMap --lastname Admin --email admin@openmap.local --password "$ADMIN_PASSWORD" || true
superset init
superset fab create-role --name OpenMapEmbedded || true
exec gunicorn --bind 0.0.0.0:8088 --workers 2 --timeout 120 "superset.app:create_app()"

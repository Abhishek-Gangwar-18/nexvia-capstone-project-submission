#!/bin/sh
# Entry point for the FlowBoard backend image.
#   web     -> (optional) migrate + seed, then gunicorn on :8000
#   worker  -> Celery worker
#   beat    -> Celery beat (scheduled digests / overdue reminders)
#   anything else is executed as-is (e.g. `python manage.py createsuperuser`).
set -e

wait_for_db() {
    python - <<'PY'
import sys, time
import django
from django.db import connection
django.setup()
for attempt in range(60):
    try:
        connection.ensure_connection()
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        print(f"waiting for database... ({exc.__class__.__name__})", flush=True)
        time.sleep(2)
print("database not reachable, giving up", flush=True)
sys.exit(1)
PY
}

export DJANGO_SETTINGS_MODULE="${DJANGO_SETTINGS_MODULE:-config.settings}"

case "$1" in
    web)
        wait_for_db
        if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
            python manage.py migrate --noinput
        fi
        if [ "${SEED_DEMO_DATA:-false}" = "true" ]; then
            # Idempotent: existing demo workspaces are skipped.
            python manage.py seed_demo
        fi
        exec gunicorn config.wsgi:application \
            --bind 0.0.0.0:8000 \
            --workers "${GUNICORN_WORKERS:-3}" \
            --timeout "${GUNICORN_TIMEOUT:-60}" \
            --error-logfile -
        # No gunicorn access log: Django's flowboard.request line has the request id, tenant and user.
        ;;
    worker)
        wait_for_db
        exec celery -A config worker --loglevel "${CELERY_LOG_LEVEL:-info}" --concurrency "${CELERY_CONCURRENCY:-2}"
        ;;
    beat)
        wait_for_db
        exec celery -A config beat --loglevel "${CELERY_LOG_LEVEL:-info}" --schedule /app/run/celerybeat-schedule
        ;;
    *)
        exec "$@"
        ;;
esac

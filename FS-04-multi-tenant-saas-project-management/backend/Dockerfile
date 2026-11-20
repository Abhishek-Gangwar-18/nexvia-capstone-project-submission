# FlowBoard backend image: Django API (gunicorn), Celery worker and Celery beat all run from this image.
# Build:  docker build -t flowboard-backend ./backend

FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# psycopg[binary] ships its own libpq, so no system build packages are needed.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Collect Django admin / Swagger static files into the image (served by whitenoise).
RUN DJANGO_STATICFILES_STORAGE=whitenoise.storage.CompressedManifestStaticFilesStorage \
    python manage.py collectstatic --noinput

RUN useradd --create-home --uid 1000 flowboard \
    && mkdir -p /app/media /app/run \
    && chown -R flowboard:flowboard /app/media /app/run \
    && sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && chmod +x /app/docker-entrypoint.sh

USER flowboard

ENV DJANGO_STATICFILES_STORAGE=whitenoise.storage.CompressedManifestStaticFilesStorage \
    DJANGO_DEBUG=False \
    DJANGO_MEDIA_ROOT=/app/media

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["web"]

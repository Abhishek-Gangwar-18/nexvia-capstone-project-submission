"""Django settings for FlowBoard. All environment-specific values come from env vars / .env."""
import os
from datetime import timedelta
from pathlib import Path

import dj_database_url
from celery.schedules import crontab
from corsheaders.defaults import default_headers
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# .env lives at the repo root (shared with docker compose); backend/.env may override it.
load_dotenv(BASE_DIR.parent / ".env")
load_dotenv(BASE_DIR / ".env", override=True)


def env_bool(name, default=False):
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def env_list(name, default=""):
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-insecure-change-me-please-use-a-long-random-string-in-prod")
DEBUG = env_bool("DJANGO_DEBUG", True)
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # third party
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "django_filters",
    "drf_spectacular",
    # local apps
    "apps.core",
    "apps.accounts",
    "apps.tenants",
    "apps.projects",
    "apps.issues",
    "apps.automation",
    "apps.billing",
]

MIDDLEWARE = [
    # First, so the request id and timing cover everything below it.
    "apps.core.request_logging.RequestLogMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.core.middleware.TenantMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": dj_database_url.config(
        default="postgres://flowboard:flowboard@localhost:5432/flowboard",
        conn_max_age=60,
        conn_health_checks=True,
    )
}

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "media/"
MEDIA_ROOT = Path(os.getenv("DJANGO_MEDIA_ROOT", BASE_DIR / "media"))

# Docker sets this to whitenoise's CompressedManifestStaticFilesStorage (needs collectstatic, which the
# image runs at build time). Local dev and tests keep Django's plain storage so nothing has to be collected.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {
        "BACKEND": os.getenv("DJANGO_STATICFILES_STORAGE", "django.contrib.staticfiles.storage.StaticFilesStorage"),
    },
}
if STORAGES["staticfiles"]["BACKEND"].startswith("whitenoise."):
    # Serve the collected admin/Swagger static files from gunicorn, right after SecurityMiddleware.
    MIDDLEWARE.insert(MIDDLEWARE.index("django.middleware.security.SecurityMiddleware") + 1,
                      "whitenoise.middleware.WhiteNoiseMiddleware")

# --- Production / reverse proxy ---------------------------------------------------------------
# nginx terminates the client connection and forwards X-Forwarded-Proto, so Django knows when the
# original request was HTTPS. The flags below stay off unless set, so plain-HTTP local runs keep working.
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "")
USE_X_FORWARDED_HOST = env_bool("DJANGO_USE_X_FORWARDED_HOST", False)
if env_bool("DJANGO_BEHIND_PROXY", False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", False)
SESSION_COOKIE_SECURE = env_bool("DJANGO_SECURE_COOKIES", False)
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SECURE_HSTS_SECONDS = int(os.getenv("DJANGO_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = SECURE_HSTS_SECONDS > 0
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"

# Every line carries the request id, tenant and user (apps/core/request_logging.py), e.g.
#   2026-11-05 19:20:25,312 INFO    [req=3f9c1a2b7d4e tenant=acme user=12] flowboard.request: POST /api/issues/WEB-4/move/ 200 18ms role=owner
LOG_CONTEXT_FORMAT = "[req=%(request_id)s tenant=%(tenant)s user=%(user_id)s]"
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "context": {"()": "apps.core.request_logging.ContextFilter"},
        "skip_client_errors": {"()": "apps.core.request_logging.SkipClientErrorResponses"},
    },
    "formatters": {"context": {"format": f"%(asctime)s %(levelname)-7s {LOG_CONTEXT_FORMAT} %(name)s: %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "context", "filters": ["context"]}},
    "root": {"handlers": ["console"], "level": os.getenv("DJANGO_LOG_LEVEL", "INFO")},
    "loggers": {
        # Drops Django's default plain console handler, so django.* lines print once, with context, via root.
        "django": {"level": "INFO"},
        "django.request": {"filters": ["skip_client_errors"]},
        "django.db.backends": {"level": "WARNING"},
        # flowboard.request replaces runserver's own access line, which has no request id or tenant.
        "django.server": {"handlers": [], "level": "ERROR", "propagate": False},
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6380/0")


def _redis_db(url, db):
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{db}"))


# Shared cache: every API process (and worker) sees the same throttle and lockout counters. Without it each
# gunicorn worker counts on its own, multiplying every limit. Database 1, so it never touches the broker (0).
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": os.getenv("CACHE_URL", _redis_db(REDIS_URL, 1)),
        "KEY_PREFIX": "flowboard",
        "TIMEOUT": 300,
    }
}
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
PASSWORD_RESET_TIMEOUT = 60 * 60  # reset links expire after one hour
# Absolute per-file ceiling, whatever the plan allows (plans cap at 100 MB; nginx allows 110 MB bodies).
FILE_UPLOAD_HARD_LIMIT = 100 * 1024 * 1024
MAX_WEBHOOKS_PER_WORKSPACE = int(os.getenv("MAX_WEBHOOKS_PER_WORKSPACE", "10"))
WEBHOOK_AUTO_DISABLE_AFTER = 20  # consecutive failed deliveries
RETENTION_DAYS = {
    "webhook_deliveries": 30, "read_notifications": 90, "unread_notifications": 180, "reports": 90,
    "stripe_events": 90,  # well past Stripe's 3-day retry window, so duplicates are still recognised
}
MAX_OWNED_WORKSPACES = int(os.getenv("MAX_OWNED_WORKSPACES", "10"))
INVITATION_RESEND_COOLDOWN = 60  # seconds
INVITATION_RETENTION_DAYS = 30  # expired, unaccepted invitations are purged after this

# --- REST API -------------------------------------------------------------------------------

REST_FRAMEWORK = {
    # JWT only. Django admin keeps its own session login; the DRF browsable API's login no longer applies.
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.OptionalPageNumberPagination",
    "DEFAULT_SCHEMA_CLASS": "apps.core.schema.TenantAutoSchema",
    "EXCEPTION_HANDLER": "apps.core.exceptions.exception_handler",
    # Per IP for anonymous calls, per user once authenticated (change-password).
    "DEFAULT_THROTTLE_RATES": {
        "auth_login": "5/min",
        "auth_register": "10/hour",
        "auth_refresh": "30/min",
        "auth_change_password": "5/hour",
        "auth_password_reset": "5/hour",
        "auth_password_reset_confirm": "10/hour",
        "workspace_create": "10/hour",
        "invitation_public": "30/min",
        "webhook_test": "5/min",  # per endpoint
        "webhook_test_user": "10/min",  # per user, so extra endpoints don't multiply the limit
        "webhook_redeliver": "5/min",  # per user
        "report_create": "10/hour",  # per user
        "billing_session": "10/min",  # per user: checkout and portal
        "billing_sync": "6/min",  # per workspace
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": True,
}

SPECTACULAR_SETTINGS = {
    "TITLE": "FlowBoard API",
    "DESCRIPTION": "Multi-tenant project management API. Send `Authorization: Bearer <access>` and "
                   "`X-Workspace: <slug>` on workspace-scoped endpoints.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
}

CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
CORS_ALLOW_HEADERS = (*default_headers, "x-workspace")

# Test-mode keys only in development. The secret stays on the server; checkout happens on Stripe's own pages.
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")

# Prints emails to the worker's terminal by default. For real delivery set EMAIL_BACKEND to
# django.core.mail.backends.smtp.EmailBackend and fill in the SMTP values.
EMAIL_BACKEND = os.getenv("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
EMAIL_HOST = os.getenv("EMAIL_HOST", "localhost")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", True)
EMAIL_TIMEOUT = 10
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", "FlowBoard <no-reply@flowboard.test>")

CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", REDIS_URL)
# Nothing reads task results: outcomes are stored on WebhookDelivery / WorkspaceReport / Notification.
CELERY_TASK_IGNORE_RESULT = True
CELERY_TIMEZONE = TIME_ZONE
# Fail fast when Redis is down. By default publishing blocks for minutes, which would hang every issue edit.
CELERY_TASK_PUBLISH_RETRY = False
CELERY_BROKER_CONNECTION_TIMEOUT = 2
CELERY_BROKER_TRANSPORT_OPTIONS = {"socket_connect_timeout": 2, "socket_timeout": 5}
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_TASK_TIME_LIMIT = 300
CELERY_TASK_SOFT_TIME_LIMIT = 240
WORKSPACE_DELETE_BATCH = int(os.getenv("WORKSPACE_DELETE_BATCH", "500"))  # rows per short transaction

CELERY_BEAT_SCHEDULE = {
    "daily-overdue-reminders": {"task": "apps.automation.tasks.create_overdue_reminders", "schedule": crontab(hour=8, minute=0)},
    "daily-workspace-digests": {"task": "apps.automation.tasks.create_daily_digests", "schedule": crontab(hour=8, minute=5)},
    "daily-purge-expired-invitations": {"task": "apps.automation.tasks.purge_expired_invitations", "schedule": crontab(hour=3, minute=0)},
    "nightly-retention-purge": {"task": "apps.automation.tasks.purge_old_records", "schedule": crontab(hour=3, minute=15)},
    "nightly-attachment-file-sweep": {"task": "apps.automation.tasks.sweep_attachment_files", "schedule": crontab(hour=3, minute=30)},
    "resume-stalled-workspace-deletions": {"task": "apps.automation.tasks.resume_stalled_deletions", "schedule": crontab(minute="*/10")},
    "recover-stalled-webhooks": {"task": "apps.automation.tasks.recover_stalled_deliveries", "schedule": crontab(minute="*/5")},
}

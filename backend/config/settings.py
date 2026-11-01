"""Django settings for FlowBoard. All environment-specific values come from env vars / .env."""
import os
from datetime import timedelta
from pathlib import Path

import dj_database_url
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
]

MIDDLEWARE = [
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
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6380/0")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

# --- REST API -------------------------------------------------------------------------------

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.OptionalPageNumberPagination",
    "DEFAULT_SCHEMA_CLASS": "apps.core.schema.TenantAutoSchema",
    "EXCEPTION_HANDLER": "apps.core.exceptions.exception_handler",
    "DEFAULT_THROTTLE_RATES": {"auth": "20/min"},
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

CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", REDIS_URL)
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", REDIS_URL)
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_TIME_LIMIT = 300
CELERY_TASK_SOFT_TIME_LIMIT = 240
CELERY_BEAT_SCHEDULE = {
    "daily-overdue-reminders": {"task": "apps.automation.tasks.create_overdue_reminders", "schedule": 60 * 60 * 24},
    "daily-workspace-digests": {"task": "apps.automation.tasks.create_daily_digests", "schedule": 60 * 60 * 24},
}

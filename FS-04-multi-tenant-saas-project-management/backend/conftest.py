import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from config.celery import app as celery_app
from apps.accounts.models import User
from apps.projects.services import create_project
from apps.tenants.models import Membership
from apps.tenants.services import create_workspace

# Tests must never publish to the real Redis, where a running worker would act on the dev database.
celery_app.conf.task_always_eager = True


@pytest.fixture
def make_user(db):
    counter = {"n": 0}

    def _make(email=None, **extra):
        counter["n"] += 1
        return User.objects.create_user(email=email or f"user{counter['n']}@example.test", password="pass12345", **extra)

    return _make


@pytest.fixture
def tenant_a(make_user):
    owner = make_user("owner@a.test")
    workspace = create_workspace(name="Acme", owner=owner)
    project = create_project(workspace=workspace, name="Website", key="WEB", created_by=owner)
    return {"workspace": workspace, "owner": owner, "project": project}


@pytest.fixture
def tenant_b(make_user):
    owner = make_user("owner@b.test")
    workspace = create_workspace(name="Globex", owner=owner)
    project = create_project(workspace=workspace, name="Website", key="WEB", created_by=owner)
    return {"workspace": workspace, "owner": owner, "project": project}


@pytest.fixture
def add_member():
    def _add(workspace, user, role=Membership.Role.MEMBER):
        return Membership.objects.create(workspace=workspace, user=user, role=role)

    return _add


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    cache.clear()


@pytest.fixture
def api():
    """api(user, workspace) -> APIClient authenticated as `user` with X-Workspace set."""

    def _client(user=None, workspace=None):
        client = APIClient()
        if user is not None:
            client.force_authenticate(user)
        if workspace is not None:
            client.credentials(HTTP_X_WORKSPACE=workspace.slug)
        return client

    return _client

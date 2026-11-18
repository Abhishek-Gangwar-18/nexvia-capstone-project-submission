"""Schema review, table #10 (projects_project): a PATCH never rewinds issue_counter (lock + re-read + changed
columns only), issue counts via subqueries and only where shown, description/name CHECKs, no redundant index."""
import threading
from unittest.mock import patch

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.issues.models import Issue
from apps.projects.models import PROJECT_DESCRIPTION_MAX, Project, WorkflowStatus
from apps.projects.views import ProjectViewSet

pytestmark = pytest.mark.django_db


def owner(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


def url(tenant):
    return f"/api/projects/{tenant['project'].key}/"


def counter(tenant):
    return Project.objects.values_list("issue_counter", flat=True).get(pk=tenant["project"].pk)


# ---------------------------------------------------------- 1. lost update on PATCH

class TestNoLostUpdate:
    def test_issue_created_during_a_patch_keeps_its_number(self, api, tenant_a):
        """The exact race from the review: an issue is created between loading and saving the project."""
        Issue.objects.create(project=tenant_a["project"], title="first")
        real = ProjectViewSet.get_object

        def stale(view):
            obj = real(view)
            Issue.objects.create(project=Project.objects.get(pk=obj.pk), title="concurrent")
            return obj

        with patch.object(ProjectViewSet, "get_object", stale):
            assert owner(api, tenant_a).patch(url(tenant_a), {"name": "Renamed"}, format="json").status_code == 200
        assert counter(tenant_a) == 2
        nxt = Issue.objects.create(project=Project.objects.get(pk=tenant_a["project"].pk), title="next")
        assert nxt.number == 3
        assert Project.objects.get(pk=tenant_a["project"].pk).name == "Renamed"

    def test_patch_sql_never_writes_issue_counter(self, api, tenant_a):
        with CaptureQueriesContext(connection) as queries:
            res = owner(api, tenant_a).patch(url(tenant_a), {"description": "new"}, format="json")
        assert res.status_code == 200
        updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "projects_project"')]
        assert updates and not any("issue_counter" in s for s in updates)
        assert all('"description"' in s for s in updates)

    def test_archive_rules_use_the_current_row(self, api, tenant_a):
        """Loaded while active, archived by someone else before the lock: the rename must be refused."""
        real = ProjectViewSet.get_object

        def stale(view):
            obj = real(view)
            Project.objects.filter(pk=obj.pk).update(is_archived=True)
            return obj

        with patch.object(ProjectViewSet, "get_object", stale):
            res = owner(api, tenant_a).patch(url(tenant_a), {"name": "Sneaky"}, format="json")
        assert res.status_code == 400
        assert Project.objects.get(pk=tenant_a["project"].pk).name != "Sneaky"

    def test_restore_still_works(self, api, tenant_a):
        Project.objects.filter(pk=tenant_a["project"].pk).update(is_archived=True)
        res = owner(api, tenant_a).patch(url(tenant_a), {"is_archived": False}, format="json")
        assert res.status_code == 200 and res.data["is_archived"] is False


@pytest.mark.django_db(transaction=True)
def test_concurrent_creates_and_patches_keep_numbers_unique(tenant_a):
    from rest_framework.test import APIClient

    project = tenant_a["project"]
    errors, codes = [], []
    barrier = threading.Barrier(8)

    def client():
        c = APIClient()
        c.force_authenticate(tenant_a["owner"])
        c.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        return c

    def creator(i):
        try:
            c = client()
            barrier.wait()
            for n in range(3):
                codes.append(c.post("/api/issues/", {"project": project.pk, "title": f"t{i}-{n}"},
                                    format="json").status_code)
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(repr(exc))
        finally:
            connection.close()

    def patcher(i):
        try:
            c = client()
            barrier.wait()
            for n in range(3):
                codes.append(c.patch(f"/api/projects/{project.key}/", {"name": f"Name {i}-{n}"},
                                     format="json").status_code)
        except Exception as exc:  # pragma: no cover
            errors.append(repr(exc))
        finally:
            connection.close()

    threads = [threading.Thread(target=creator, args=(i,)) for i in range(6)]
    threads += [threading.Thread(target=patcher, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors and set(codes) <= {200, 201}, (errors, codes)
    numbers = list(Issue.objects.filter(project=project).values_list("number", flat=True))
    assert len(numbers) == 18 and len(set(numbers)) == 18
    assert Project.objects.get(pk=project.pk).issue_counter == max(numbers) == 18


# ----------------------------------------------------------------- 2. issue counts

class TestCounts:
    @pytest.fixture
    def issues(self, tenant_a):
        done = WorkflowStatus.objects.filter(workflow__project=tenant_a["project"], category="done").first()
        for i in range(3):
            Issue.objects.create(project=tenant_a["project"], title=f"open {i}")
        Issue.objects.create(project=tenant_a["project"], title="done", status=done)

    def test_list_and_detail_counts(self, api, tenant_a, issues):
        with CaptureQueriesContext(connection) as queries:
            listed = owner(api, tenant_a).get("/api/projects/").data
        row = next(p for p in listed if p["key"] == tenant_a["project"].key)
        assert (row["issue_count"], row["done_count"]) == (4, 1)
        assert not any("COUNT(DISTINCT" in q["sql"] for q in queries.captured_queries)
        detail = owner(api, tenant_a).get(url(tenant_a)).data
        assert (detail["issue_count"], detail["done_count"]) == (4, 1)

    def test_patch_lookup_skips_counts_but_response_has_them(self, api, tenant_a, issues):
        with CaptureQueriesContext(connection) as queries:
            res = owner(api, tenant_a).patch(url(tenant_a), {"color": "#112233"}, format="json")
        assert (res.data["issue_count"], res.data["done_count"]) == (4, 1)
        counted = [q["sql"] for q in queries.captured_queries if 'AS "issue_count"' in q["sql"]]
        assert len(counted) == 1  # only the response re-read, not the lookup

    def test_delete_lookup_skips_counts(self, api, tenant_a, issues):
        with CaptureQueriesContext(connection) as queries:
            res = owner(api, tenant_a).delete(url(tenant_a), {"confirm": tenant_a["project"].key}, format="json")
        assert res.status_code == 204
        assert not any('AS "issue_count"' in q["sql"] for q in queries.captured_queries)


# ---------------------------------------------------------- 3-4. description and name

class TestTextChecks:
    def test_description_limit_on_the_api(self, api, tenant_a):
        assert owner(api, tenant_a).patch(url(tenant_a), {"description": "x" * PROJECT_DESCRIPTION_MAX},
                                          format="json").status_code == 200
        res = owner(api, tenant_a).patch(url(tenant_a), {"description": "x" * (PROJECT_DESCRIPTION_MAX + 1)},
                                         format="json")
        assert res.status_code == 400 and "10,000" in str(res.data["description"])

    def test_description_limit_in_the_db_counts_characters(self, tenant_a):
        qs = Project.objects.filter(pk=tenant_a["project"].pk)
        qs.update(description="é" * PROJECT_DESCRIPTION_MAX)
        with pytest.raises(IntegrityError), transaction.atomic():
            qs.update(description="é" * (PROJECT_DESCRIPTION_MAX + 1))

    def test_blank_name_rejected_by_api_and_db(self, api, tenant_a):
        for name in ("", "   "):
            assert owner(api, tenant_a).patch(url(tenant_a), {"name": name}, format="json").status_code == 400
            with pytest.raises(IntegrityError), transaction.atomic():
                Project.objects.filter(pk=tenant_a["project"].pk).update(name=name)


# ------------------------------------------------------------------- 6. indexes

def test_redundant_workspace_index_dropped():
    with connection.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'projects_project'")
        defs = [r[0] for r in cur.fetchall()]
    assert not any(d.endswith("btree (workspace_id)") for d in defs)
    assert any("UNIQUE" in d and "(workspace_id, key)" in d for d in defs)
    assert any(d.endswith("btree (lead_id)") for d in defs) and any(d.endswith("btree (created_by_id)") for d in defs)

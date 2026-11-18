"""Schema review, table #19 (automation_webhookendpoint): a PATCH can't undo an auto-disable or overwrite other
admins' changes (lock, re-read, re-validate, submitted fields only; reset only on an explicit re-enable of a row
that is disabled NOW); DB CHECKs for disable metadata, events array and non-blank names."""
from unittest.mock import patch

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.models import F
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.automation.models import WebhookEndpoint
from apps.automation.views import WebhookEndpointViewSet

pytestmark = pytest.mark.django_db
REASON = "Disabled after 5 failed deliveries in a row."


@pytest.fixture
def ep(tenant_a):
    return WebhookEndpoint.objects.create(workspace=tenant_a["workspace"], name="Hook", url="https://hooks.test/x",
                                          events=["*"], consecutive_failures=4)


def patch_ep(api, tenant, ep, body):
    return api(tenant["owner"], tenant["workspace"]).patch(f"/api/webhooks/{ep.pk}/", body, format="json")


def meanwhile(fn):
    real = WebhookEndpointViewSet.get_object

    def stale(view):
        obj = real(view)
        if view.action == "partial_update":
            fn(obj)
        return obj

    return patch.object(WebhookEndpointViewSet, "get_object", stale)


def worker_fifth_failure(obj):
    """Exactly what _record_final_failure does: atomic increment, then the conditional flip."""
    WebhookEndpoint.objects.filter(pk=obj.pk).update(consecutive_failures=F("consecutive_failures") + 1)
    WebhookEndpoint.objects.filter(pk=obj.pk, is_active=True, consecutive_failures__gte=5).update(
        is_active=False, disabled_at=timezone.now(), disabled_reason=REASON)


# ============================================================ 1. PATCH races

class TestPatchRaces:
    def test_rename_vs_fifth_failure_keeps_the_auto_disable(self, api, tenant_a, ep):
        with meanwhile(worker_fifth_failure):
            res = patch_ep(api, tenant_a, ep, {"name": "Renamed"})
        assert res.status_code == 200
        ep.refresh_from_db()
        assert (ep.name, ep.is_active, ep.consecutive_failures, ep.disabled_reason) == ("Renamed", False, 5, REASON)
        assert ep.disabled_at is not None and res.data["is_active"] is False

    def test_rename_vs_another_admins_re_enable(self, api, tenant_a, ep):
        WebhookEndpoint.objects.filter(pk=ep.pk).update(is_active=False, disabled_at=timezone.now(),
                                                        disabled_reason=REASON, consecutive_failures=5)

        def other_admin(obj):
            WebhookEndpoint.objects.filter(pk=obj.pk).update(is_active=True, consecutive_failures=0,
                                                             disabled_at=None, disabled_reason="")

        with meanwhile(other_admin):
            assert patch_ep(api, tenant_a, ep, {"name": "Renamed"}).status_code == 200
        ep.refresh_from_db()
        assert (ep.name, ep.is_active, ep.consecutive_failures, ep.disabled_at) == ("Renamed", True, 0, None)

    def test_rename_vs_another_admins_url_change(self, api, tenant_a, ep):
        def other_admin(obj):
            WebhookEndpoint.objects.filter(pk=obj.pk).update(url="https://hooks.test/new")

        with meanwhile(other_admin):
            assert patch_ep(api, tenant_a, ep, {"name": "Renamed"}).status_code == 200
        ep.refresh_from_db()
        assert (ep.name, ep.url) == ("Renamed", "https://hooks.test/new")

    def test_re_enable_resets_bookkeeping_once(self, api, tenant_a, ep):
        WebhookEndpoint.objects.filter(pk=ep.pk).update(is_active=False, disabled_at=timezone.now(),
                                                        disabled_reason=REASON, consecutive_failures=5)
        with CaptureQueriesContext(connection) as first:
            assert patch_ep(api, tenant_a, ep, {"is_active": True}).status_code == 200
        ep.refresh_from_db()
        assert (ep.is_active, ep.consecutive_failures, ep.disabled_at, ep.disabled_reason) == (True, 0, None, "")
        WebhookEndpoint.objects.filter(pk=ep.pk).update(consecutive_failures=2)  # new failures after re-enabling
        with CaptureQueriesContext(connection) as second:
            assert patch_ep(api, tenant_a, ep, {"is_active": True}).status_code == 200  # already active
        assert WebhookEndpoint.objects.get(pk=ep.pk).consecutive_failures == 2  # not reset again
        resets = lambda qs: [q["sql"] for q in qs.captured_queries
                             if q["sql"].startswith('UPDATE "automation_webhookendpoint"') and "consecutive_failures" in q["sql"]]
        assert len(resets(first)) == 1 and resets(second) == []

    def test_stale_copy_never_decides_whether_to_reset(self, api, tenant_a, ep):
        # Loaded while active; the worker disables it before the lock; the PATCH explicitly re-enables: the row
        # is disabled NOW, so the reset applies.
        with meanwhile(worker_fifth_failure):
            assert patch_ep(api, tenant_a, ep, {"is_active": True}).status_code == 200
        ep.refresh_from_db()
        assert (ep.is_active, ep.consecutive_failures, ep.disabled_at) == (True, 0, None)

    def test_stale_disabled_copy_does_not_reset_a_live_endpoint(self, api, tenant_a, ep):
        WebhookEndpoint.objects.filter(pk=ep.pk).update(is_active=False, disabled_at=timezone.now(),
                                                        disabled_reason=REASON, consecutive_failures=5)

        def re_enabled_then_failing(obj):
            WebhookEndpoint.objects.filter(pk=obj.pk).update(is_active=True, consecutive_failures=2,
                                                             disabled_at=None, disabled_reason="")

        with meanwhile(re_enabled_then_failing):
            assert patch_ep(api, tenant_a, ep, {"is_active": True}).status_code == 200
        assert WebhookEndpoint.objects.get(pk=ep.pk).consecutive_failures == 2  # live row: nothing to reset

    def test_rename_never_resets_and_writes_only_submitted_fields(self, api, tenant_a, ep):
        with CaptureQueriesContext(connection) as queries:
            assert patch_ep(api, tenant_a, ep, {"name": "Renamed"}).status_code == 200
        assert WebhookEndpoint.objects.get(pk=ep.pk).consecutive_failures == 4
        updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "automation_webhookendpoint"')]
        assert len(updates) == 1
        written = updates[0].split(" SET ")[1].split(" WHERE ")[0]
        assert '"name"' in written and '"updated_at"' in written
        for untouched in ('"is_active"', '"consecutive_failures"', '"disabled_at"', '"url"', '"events"', '"secret"'):
            assert untouched not in written

    def test_validation_runs_on_the_fresh_row(self, api, tenant_a, ep):
        assert patch_ep(api, tenant_a, ep, {"url": "http://insecure.test/"}).status_code == 400
        assert patch_ep(api, tenant_a, ep, {"events": ["nope"]}).status_code == 400


# ================================================================ 2-4. CHECKs

class TestChecks:
    @pytest.mark.parametrize("change", [{"disabled_at": timezone.now()}, {"disabled_reason": "x"}])
    def test_active_with_disable_metadata_rejected(self, ep, change):
        with pytest.raises(IntegrityError), transaction.atomic():
            WebhookEndpoint.objects.filter(pk=ep.pk).update(**change)

    def test_inactive_without_metadata_accepted(self, ep):
        WebhookEndpoint.objects.filter(pk=ep.pk).update(is_active=False)  # a manual disable

    @pytest.mark.parametrize("bad", ['{"x": 1}', '"issue.created"', '3', 'null'])
    def test_events_must_be_an_array(self, ep, bad):
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("UPDATE automation_webhookendpoint SET events = %s::jsonb WHERE id = %s", [bad, ep.pk])

    @pytest.mark.parametrize("good", ['[]', '["*"]', '["issue.created", "issue.updated"]'])
    def test_arrays_accepted(self, ep, good):
        with connection.cursor() as cur:
            cur.execute("UPDATE automation_webhookendpoint SET events = %s::jsonb WHERE id = %s", [good, ep.pk])

    @pytest.mark.parametrize("name", ["", "   "])
    def test_blank_names_rejected(self, api, tenant_a, ep, name):
        assert patch_ep(api, tenant_a, ep, {"name": name}).status_code == 400
        with pytest.raises(IntegrityError), transaction.atomic():
            WebhookEndpoint.objects.filter(pk=ep.pk).update(name=name)


# ------------------------------------------------ migration: report, no repairs

@pytest.mark.django_db(transaction=True)
def test_migration_reports_invalid_endpoints(ep):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    try:
        MigrationExecutor(connection).migrate([("automation", "0008_report_pending_identity_error_check")])
        with connection.cursor() as cur:
            cur.execute("UPDATE automation_webhookendpoint SET disabled_reason = 'stale', events = '{}'::jsonb "
                        "WHERE id = %s", [ep.pk])
        with pytest.raises(RuntimeError, match=str(ep.pk)):
            latest()
        with connection.cursor() as cur:
            cur.execute("SELECT disabled_reason, events::text FROM automation_webhookendpoint WHERE id = %s", [ep.pk])
            assert cur.fetchone() == ("stale", "{}")  # untouched
    finally:
        with connection.cursor() as cur:
            cur.execute("UPDATE automation_webhookendpoint SET disabled_reason = '', events = '[\"*\"]'::jsonb "
                        "WHERE id = %s", [ep.pk])
        latest()

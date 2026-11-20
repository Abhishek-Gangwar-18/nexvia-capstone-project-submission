import logging

import pytest

from apps.core.request_logging import ContextFilter, get_log_context, log_context
from config.celery import LOG_CONTEXT_HEADER, attach_log_context

pytestmark = pytest.mark.django_db


def access_records(caplog):
    return [r for r in caplog.records if r.name == "flowboard.request"]


class TestRequestId:
    def test_generated_and_returned(self, api, tenant_a):
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/")
        request_id = res["X-Request-ID"]
        assert len(request_id) == 12 and request_id.isalnum()

    def test_trusted_header_is_kept(self, api, tenant_a):
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/", HTTP_X_REQUEST_ID="edge-abc-123")
        assert res["X-Request-ID"] == "edge-abc-123"

    @pytest.mark.parametrize("bad", ["", "x" * 65, "evil\nnewline", "spaces here", "<script>"])
    def test_unsafe_header_is_replaced(self, api, tenant_a, bad):
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/", HTTP_X_REQUEST_ID=bad)
        assert res["X-Request-ID"] != bad and len(res["X-Request-ID"]) == 12

    def test_each_request_gets_its_own_id(self, api, tenant_a):
        client = api(tenant_a["owner"], tenant_a["workspace"])
        assert client.get("/api/projects/")["X-Request-ID"] != client.get("/api/projects/")["X-Request-ID"]


class TestAccessLog:
    def test_line_names_tenant_user_role_status_and_timing(self, api, tenant_a, caplog):
        caplog.set_level(logging.INFO, logger="flowboard.request")
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/")
        [record] = access_records(caplog)
        assert record.request_id == res["X-Request-ID"]
        assert record.tenant == tenant_a["workspace"].slug
        assert record.user_id == str(tenant_a["owner"].pk)
        assert record.role == "owner" and record.http_status == 200 and record.duration_ms >= 0
        assert "GET /api/projects/ 200" in record.getMessage()

    def test_other_tenant_is_logged_as_unverified_with_warning(self, api, tenant_a, tenant_b, caplog):
        caplog.set_level(logging.INFO, logger="flowboard.request")
        res = api(tenant_a["owner"], tenant_b["workspace"]).get("/api/projects/")
        assert res.status_code == 404
        [record] = access_records(caplog)
        assert record.tenant == f"{tenant_b['workspace'].slug}(unverified)"
        assert record.levelno == logging.WARNING and record.role == "-"

    def test_anonymous_and_non_workspace_requests(self, api, tenant_a, caplog):
        caplog.set_level(logging.INFO, logger="flowboard.request")
        api().get("/api/health/")
        api(tenant_a["owner"]).get("/api/workspaces/")
        health, workspaces = access_records(caplog)
        assert (health.tenant, health.user_id) == ("-", "-")
        assert workspaces.tenant == "-" and workspaces.user_id == str(tenant_a["owner"].pk)

    def test_lines_logged_inside_the_view_carry_the_context(self, api, tenant_a, monkeypatch):
        from apps.projects.views import ProjectViewSet

        seen = {}
        original = ProjectViewSet.get_queryset

        def spy(self):
            record = logging.LogRecord("app", logging.INFO, __file__, 1, "inside the view", None, None)
            ContextFilter().filter(record)
            seen.update(request_id=record.request_id, tenant=record.tenant, user_id=record.user_id)
            return original(self)

        monkeypatch.setattr(ProjectViewSet, "get_queryset", spy)
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/")
        assert seen == {
            "request_id": res["X-Request-ID"], "tenant": tenant_a["workspace"].slug, "user_id": str(tenant_a["owner"].pk),
        }

    def test_django_4xx_duplicates_are_dropped_but_5xx_kept(self):
        from apps.core.request_logging import SkipClientErrorResponses

        def record(status):
            r = logging.LogRecord("django.request", logging.WARNING, __file__, 1, "x", None, None)
            r.status_code = status
            return r

        keep = SkipClientErrorResponses().filter
        assert not keep(record(400)) and not keep(record(404))
        assert keep(record(500))

    def test_context_does_not_leak_between_requests(self, api, tenant_a):
        api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/")
        assert get_log_context() == {}


class TestFilterAndCelery:
    def test_filter_defaults_outside_a_request(self):
        record = logging.LogRecord("x", logging.INFO, __file__, 1, "msg", None, None)
        ContextFilter().filter(record)
        assert (record.request_id, record.tenant, record.user_id) == ("-", "-", "-")

    def test_request_context_is_sent_with_queued_tasks(self):
        headers = {}
        with log_context(request_id="abc123", tenant="acme", user_id="7"):
            attach_log_context(headers=headers)
        assert headers[LOG_CONTEXT_HEADER] == {"request_id": "abc123", "tenant": "acme", "user_id": "7"}

    def test_nothing_is_sent_outside_a_request(self):
        headers = {}
        attach_log_context(headers=headers)
        assert LOG_CONTEXT_HEADER not in headers

"""Schema review, table #3 (tenants_membership): no default ordering, lean hot-path SQL, seat counting."""
import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.accounts.models import User
from apps.billing.limits import check_can_add_member, usage
from apps.billing.limits import PlanLimitReached
from apps.tenants.models import Membership, Workspace
from apps.tenants.services import transfer_ownership
from apps.tenants.views import annotated_workspaces

pytestmark = pytest.mark.django_db
Role = Membership.Role


def membership_selects(queries):
    return [q["sql"] for q in queries.captured_queries
            if q["sql"].startswith("SELECT") and 'FROM "tenants_membership"' in q["sql"]]


def test_no_default_ordering():
    assert Membership._meta.ordering == []


def test_per_request_workspace_check_has_no_user_join_or_sort(api, tenant_a):
    client = api(tenant_a["owner"], tenant_a["workspace"])
    with CaptureQueriesContext(connection) as queries:
        assert client.get("/api/labels/").status_code == 200
    resolve = [s for s in membership_selects(queries) if '"tenants_workspace"."slug"' in s]
    assert len(resolve) == 1, resolve
    sql = resolve[0]
    assert '"accounts_user"' not in sql and "ORDER BY" not in sql


def test_unknown_or_foreign_workspace_still_404(api, tenant_a, tenant_b):
    owner = tenant_a["owner"]
    for slug in ("nope", tenant_b["workspace"].slug):
        client = api(owner)
        client.credentials(HTTP_X_WORKSPACE=slug)
        res = client.get("/api/labels/")
        assert res.status_code == 404 and res.data["detail"] == "Workspace not found."


def test_switcher_role_subquery_is_lean(tenant_a):
    sql = str(annotated_workspaces(tenant_a["owner"]).query)
    role_sub = sql[sql.index('(SELECT U0."role"'):sql.index('AS "my_role"')]
    assert "accounts_user" not in role_sub and "ORDER BY" not in role_sub
    row = annotated_workspaces(tenant_a["owner"]).get(pk=tenant_a["workspace"].pk)
    assert row.my_role == Role.OWNER


def test_members_list_still_sorted_by_name(api, tenant_a, make_user, add_member):
    for first, email in (("Zed", "z@a.test"), ("Amy", "a@a.test"), ("Max", "m@a.test")):
        add_member(tenant_a["workspace"], make_user(email, first_name=first), Role.MEMBER)
    data = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/members/").data
    names = [m["user"]["display_name"] for m in data if m["user"]["email"].endswith("@a.test")
             and m["user"]["email"] != "owner@a.test"]
    assert names == sorted(names)


def test_transfer_locks_only_membership_rows(tenant_a, make_user, add_member):
    heir = add_member(tenant_a["workspace"], make_user("heir@a.test"), Role.ADMIN)
    with CaptureQueriesContext(connection) as queries:
        transfer_ownership(tenant_a["workspace"], tenant_a["owner"], heir.pk)
    locks = [q["sql"] for q in queries.captured_queries if "FOR UPDATE" in q["sql"] and "tenants_membership" in q["sql"]]
    assert locks and all('FOR UPDATE OF "tenants_membership"' in s for s in locks)


def test_deactivated_members_still_hold_seats(tenant_a, make_user, add_member):
    ws = tenant_a["workspace"]
    ws.plan = Workspace.Plan.FREE  # 5 seats
    ws.save(update_fields=["plan"])
    for i in range(4):
        add_member(ws, make_user(f"seat{i}@a.test"), Role.MEMBER)
    User.objects.filter(email="seat0@a.test").update(is_active=False)
    current = usage(ws)
    assert current["members"] == 5 and current["deactivated_members"] == 1
    with pytest.raises(PlanLimitReached) as exc:
        check_can_add_member(ws)
    detail = str(exc.value.detail["detail"])
    assert "deactivated members (1 of them deactivated)" in detail and "Remove members" in detail

"""Schema review, table #20 (billing_subscription): one Stripe subscription per workspace, status <-> id
pairing, checkout_plan from the catalogue, no redundant LIKE index, apply_subscription writes only its fields."""
import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.billing.models import Subscription
from apps.billing.plans import PAID_PLANS
from apps.billing.services import apply_subscription

pytestmark = pytest.mark.django_db


def link(tenant, **extra):
    return Subscription.objects.create(workspace=tenant["workspace"], stripe_customer_id=f"cus_{tenant['workspace'].pk}",
                                       **extra)


def snapshot(sub_id="sub_1", status="active", lookup_key="flowboard_pro_monthly"):
    return {"id": sub_id, "status": status, "cancel_at_period_end": False,
            "items": {"data": [{"current_period_end": 1900000000, "price": {"id": "price_x", "lookup_key": lookup_key}}]}}


# ============================================================ 1. unique subscription id

class TestUniqueSubscriptionId:
    def test_duplicate_non_empty_ids_rejected(self, tenant_a, tenant_b):
        link(tenant_a, stripe_subscription_id="sub_1", status="active")
        with pytest.raises(IntegrityError), transaction.atomic():
            link(tenant_b, stripe_subscription_id="sub_1", status="active")

    def test_many_empty_ids_allowed(self, tenant_a, tenant_b):
        link(tenant_a)
        link(tenant_b)
        assert Subscription.objects.filter(stripe_subscription_id="").count() == 2

    def test_raw_update_to_a_taken_id_rejected(self, tenant_a, tenant_b):
        link(tenant_a, stripe_subscription_id="sub_1", status="active")
        other = link(tenant_b, stripe_subscription_id="sub_2", status="active")
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("UPDATE billing_subscription SET stripe_subscription_id = 'sub_1' WHERE id = %s", [other.pk])


# ============================================================ 2. status <-> id pairing

class TestStatusPairing:
    def test_both_empty_and_both_set_accepted(self, tenant_a):
        row = link(tenant_a)
        Subscription.objects.filter(pk=row.pk).update(stripe_subscription_id="sub_1", status="canceled")

    @pytest.mark.parametrize("sub_id, status", [("", "active"), ("sub_1", "")])
    def test_one_side_only_rejected(self, tenant_a, sub_id, status):
        row = link(tenant_a)
        with pytest.raises(IntegrityError), transaction.atomic():
            Subscription.objects.filter(pk=row.pk).update(stripe_subscription_id=sub_id, status=status)

    def test_unknown_stripe_status_still_accepted(self, tenant_a):
        row = link(tenant_a)
        Subscription.objects.filter(pk=row.pk).update(stripe_subscription_id="sub_1", status="some_future_status")
        apply_subscription(row.pk, snapshot(status="paused"), timezone.now())
        row.refresh_from_db()
        assert row.status == "paused"


# ================================================================ 3. checkout_plan

class TestCheckoutPlan:
    @pytest.mark.parametrize("plan", ["", "pro", "enterprise"])
    def test_catalogue_values_accepted(self, tenant_a, plan):
        row = link(tenant_a)
        Subscription.objects.filter(pk=row.pk).update(checkout_plan=plan)

    @pytest.mark.parametrize("plan", ["free", "PRO", "gold", " pro"])
    def test_other_values_rejected(self, tenant_a, plan):
        row = link(tenant_a)
        with pytest.raises(IntegrityError), transaction.atomic():
            Subscription.objects.filter(pk=row.pk).update(checkout_plan=plan)

    def test_db_list_matches_the_plan_catalogue(self):
        with connection.cursor() as cur:
            cur.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_subscription_checkout_plan'")
            definition = cur.fetchone()[0]
        listed = {v for v in ("pro", "enterprise", "free") if f"'{v}'" in definition}
        assert listed == set(PAID_PLANS), "plan catalogue changed: add a migration for ck_subscription_checkout_plan"


# ======================================================== 5. apply_subscription fields

def test_apply_subscription_writes_only_its_fields(tenant_a):
    row = link(tenant_a, checkout_session_id="cs_1", checkout_plan="pro")
    with CaptureQueriesContext(connection) as queries:
        apply_subscription(row.pk, snapshot(), timezone.now())
    updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "billing_subscription"')]
    assert len(updates) == 1
    written = updates[0].split(" SET ")[1].split(" WHERE ")[0]
    for field in ("stripe_subscription_id", "status", "current_period_end", "cancel_at_period_end", "synced_at",
                  "updated_at"):
        assert f'"{field}"' in written, field
    for untouched in ("checkout_session_id", "checkout_plan", "stripe_customer_id", "workspace_id"):
        assert f'"{untouched}"' not in written, untouched
    row.refresh_from_db()
    assert (row.status, row.checkout_session_id) == ("active", "cs_1")
    tenant_a["workspace"].refresh_from_db()
    assert tenant_a["workspace"].plan == "pro"


def test_stale_snapshot_guard_kept(tenant_a):
    row = link(tenant_a)
    newer = timezone.now()
    apply_subscription(row.pk, snapshot(status="active"), newer)
    apply_subscription(row.pk, snapshot(status="canceled"), newer - timezone.timedelta(seconds=5))  # started earlier
    row.refresh_from_db()
    assert row.status == "active"


# ================================================================== 4. indexes

def test_like_index_gone_unique_customer_index_kept():
    with connection.cursor() as cur:
        cur.execute("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'billing_subscription'")
        defs = dict(cur.fetchall())
    assert not any("varchar_pattern_ops" in d for d in defs.values())
    assert any("UNIQUE" in d and "(stripe_customer_id)" in d for d in defs.values())
    assert any("UNIQUE" in d and "(workspace_id)" in d for d in defs.values())
    assert "WHERE (NOT ((stripe_subscription_id)::text = ''::text))" in defs["uq_subscription_stripe_id"]


# ------------------------------------------- migration: report duplicates, no changes

@pytest.mark.django_db(transaction=True)
def test_migration_reports_duplicate_subscription_ids(tenant_a, tenant_b):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    a, b = link(tenant_a), link(tenant_b)
    try:
        MigrationExecutor(connection).migrate([("billing", "0003_stripeevent_drop_updated_at")])
        with connection.cursor() as cur:
            cur.execute("UPDATE billing_subscription SET stripe_subscription_id = 'sub_dup', status = 'active' "
                        "WHERE id IN (%s, %s)", [a.pk, b.pk])
        with pytest.raises(RuntimeError, match="sub_dup"):
            latest()
        with connection.cursor() as cur:
            cur.execute("SELECT count(*) FROM billing_subscription WHERE stripe_subscription_id = 'sub_dup'")
            assert cur.fetchone()[0] == 2  # untouched
    finally:
        with connection.cursor() as cur:
            cur.execute("UPDATE billing_subscription SET stripe_subscription_id = '', status = '' WHERE id IN (%s, %s)",
                        [a.pk, b.pk])
        latest()

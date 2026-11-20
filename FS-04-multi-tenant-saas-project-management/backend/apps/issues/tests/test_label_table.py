"""Schema review, table #9 (issues_label + issues_issue_labels): one canonical name rule (NFC + casefold, length
checked after folding), non-blank names in the DB, label limits, EXISTS label filter, no redundant M2M index,
cross-workspace links rejected on every path, and a migration that reports collisions instead of merging."""
import threading

import pytest
from django.contrib.admin.sites import site
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.issues.models import LABELS_PER_ISSUE, LABELS_PER_WORKSPACE, Issue, Label, canonical_label_name

pytestmark = pytest.mark.django_db


def client(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


def create(api, tenant, name):
    return client(api, tenant).post("/api/labels/", {"name": name, "color": "#123456"}, format="json")


# ------------------------------------------------------ 1-2. canonical names, length

class TestNames:
    def test_unicode_expansion_is_a_400_not_a_500(self, api, tenant_a):
        res = create(api, tenant_a, "İ" * 40)  # folds to 80 characters
        assert res.status_code == 400 and "40" in str(res.data["name"])
        assert create(api, tenant_a, "İ" * 20).status_code == 201  # exactly 40 once folded

    def test_ascii_limits(self, api, tenant_a):
        assert create(api, tenant_a, "a" * 40).status_code == 201
        assert create(api, tenant_a, "b" * 41).status_code == 400

    def test_greek_sigma_variants_are_one_label(self, api, tenant_a):
        assert create(api, tenant_a, "ΣΑΣ").data["name"] == "σασ"
        for variant in ("σας", "σασ", "Σας"):
            res = create(api, tenant_a, variant)
            assert res.status_code == 400 and "already exists" in str(res.data["name"]), variant

    def test_nfc_and_nfd_are_one_label(self, api, tenant_a):
        composed, decomposed = "café", "café"
        assert create(api, tenant_a, decomposed).data["name"] == composed
        assert create(api, tenant_a, composed.upper()).status_code == 400
        # 40 decomposed accents are 80 raw code points but 40 characters once composed: allowed.
        assert create(api, tenant_a, "é" * 40).status_code == 201

    def test_rename_uses_the_same_rule(self, api, tenant_a):
        first = create(api, tenant_a, "alpha").data
        create(api, tenant_a, "σασ")
        res = client(api, tenant_a).patch(f"/api/labels/{first['id']}/", {"name": "ΣΑΣ"}, format="json")
        assert res.status_code == 400

    def test_blank_names_rejected(self, api, tenant_a):
        for name in ("", "   ", "\t"):
            assert create(api, tenant_a, name).status_code == 400, repr(name)

    def test_model_save_and_admin_use_the_rule(self, tenant_a, rf):
        label = Label.objects.create(workspace=tenant_a["workspace"], name="  ΣΑΣ ")
        assert label.name == "σασ" == canonical_label_name("Σας")
        request = rf.get("/")
        request.user = tenant_a["owner"]
        form = site._registry[Label].get_form(request)(data={
            "workspace": tenant_a["workspace"].pk, "name": "İ" * 40, "color": "#123456"})
        assert not form.is_valid() and "name" in form.errors


# ------------------------------------------------------------ 3. DB: not blank

def test_db_rejects_blank_names(tenant_a):
    label = Label.objects.create(workspace=tenant_a["workspace"], name="ok")
    for bad in ("", "   "):
        with pytest.raises(IntegrityError), transaction.atomic():
            Label.objects.filter(pk=label.pk).update(name=bad)


# ------------------------------------------------------------------- 4. limits

class TestLimits:
    def test_workspace_limit(self, api, tenant_a):
        Label.objects.bulk_create([Label(workspace=tenant_a["workspace"], name=f"l{i}")
                                   for i in range(LABELS_PER_WORKSPACE - 1)])
        assert create(api, tenant_a, "last").status_code == 201
        res = create(api, tenant_a, "one-too-many")
        assert res.status_code == 400 and str(LABELS_PER_WORKSPACE) in str(res.data["name"])

    def test_issue_limit_on_the_api(self, api, tenant_a):
        issue = Issue.objects.create(project=tenant_a["project"], title="t")
        ids = [l.pk for l in Label.objects.bulk_create(
            [Label(workspace=tenant_a["workspace"], name=f"l{i}") for i in range(LABELS_PER_ISSUE + 1)])]
        url = f"/api/issues/{issue.key}/"
        assert client(api, tenant_a).patch(url, {"labels": ids[:LABELS_PER_ISSUE]}, format="json").status_code == 200
        res = client(api, tenant_a).patch(url, {"labels": ids}, format="json")
        assert res.status_code == 400 and "labels" in res.data
        # Replacing the set (not appending) stays allowed at the limit.
        assert client(api, tenant_a).patch(url, {"labels": ids[1:]}, format="json").status_code == 200
        assert issue.labels.count() == LABELS_PER_ISSUE

    def test_issue_limit_backstop_counts_the_resulting_set(self, tenant_a):
        issue = Issue.objects.create(project=tenant_a["project"], title="t")
        labels = Label.objects.bulk_create([Label(workspace=tenant_a["workspace"], name=f"l{i}")
                                            for i in range(LABELS_PER_ISSUE + 1)])
        issue.labels.set(labels[:LABELS_PER_ISSUE])
        issue.labels.add(labels[0])  # already linked: not an addition
        with pytest.raises(ValidationError), transaction.atomic():
            issue.labels.add(labels[-1])  # incremental add past the limit
        with pytest.raises(ValidationError), transaction.atomic():
            labels[-1].issues.add(issue)  # reverse side
        issue.labels.set(labels[1:])  # a replacement of the same size is fine
        assert issue.labels.count() == LABELS_PER_ISSUE


@pytest.mark.django_db(transaction=True)
def test_concurrent_creates_cannot_pass_the_workspace_limit(tenant_a):
    from rest_framework.test import APIClient

    Label.objects.bulk_create([Label(workspace=tenant_a["workspace"], name=f"l{i}")
                               for i in range(LABELS_PER_WORKSPACE - 1)])
    codes, barrier = [], threading.Barrier(2)

    def worker(name):
        c = APIClient()
        c.force_authenticate(tenant_a["owner"])
        c.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        barrier.wait()
        codes.append(c.post("/api/labels/", {"name": name, "color": "#123456"}, format="json").status_code)
        connection.close()

    threads = [threading.Thread(target=worker, args=(n,)) for n in ("x1", "x2")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [201, 400]
    assert Label.objects.filter(workspace=tenant_a["workspace"]).count() == LABELS_PER_WORKSPACE


# --------------------------------------------------------------- 5. label filter

def test_label_filter_uses_exists_and_lists_each_issue_once(api, tenant_a):
    issue = Issue.objects.create(project=tenant_a["project"], title="two labels")
    a = Label.objects.create(workspace=tenant_a["workspace"], name="a")
    b = Label.objects.create(workspace=tenant_a["workspace"], name="b")
    issue.labels.set([a, b])
    Issue.objects.create(project=tenant_a["project"], title="no labels")
    with CaptureQueriesContext(connection) as queries:
        res = client(api, tenant_a).get(f"/api/issues/?project={tenant_a['project'].key}&label={a.pk}&page=1")
    assert res.data["count"] == 1 and [i["id"] for i in res.data["results"]] == [issue.pk]
    sql = [q["sql"] for q in queries.captured_queries if 'FROM "issues_issue"' in q["sql"]]
    assert any("EXISTS" in s for s in sql) and not any("DISTINCT" in s for s in sql)


# ------------------------------------------------------------- 6. M2M indexes

def test_redundant_issue_id_index_dropped_label_id_kept():
    with connection.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'issues_issue_labels'")
        defs = [r[0] for r in cur.fetchall()]
    assert not any(d.endswith("btree (issue_id)") for d in defs)
    assert any("UNIQUE" in d and "(issue_id, label_id)" in d for d in defs)
    assert any(d.endswith("btree (label_id)") for d in defs)


# ----------------------------------------------------- 7. cross-workspace links

class TestCrossWorkspace:
    @pytest.fixture
    def foreign(self, tenant_b):
        return Label.objects.create(workspace=tenant_b["workspace"], name="theirs")

    def test_add_and_set_rejected(self, tenant_a, foreign):
        issue = Issue.objects.create(project=tenant_a["project"], title="t")
        for write in (lambda: issue.labels.add(foreign), lambda: issue.labels.set([foreign]),
                      lambda: foreign.issues.add(issue)):
            with pytest.raises(ValidationError), transaction.atomic():
                write()
        assert issue.labels.count() == 0

    def test_api_bulk_path_rejected(self, api, tenant_a, foreign):
        issue = Issue.objects.create(project=tenant_a["project"], title="t")
        own = Label.objects.create(workspace=tenant_a["workspace"], name="mine")
        res = client(api, tenant_a).patch(f"/api/issues/{issue.key}/", {"labels": [own.pk, foreign.pk]}, format="json")
        assert res.status_code == 400 and "labels" in res.data
        assert issue.labels.count() == 0


# ------------------------------------------------- migration of existing names

def _rollback_and_insert(workspace, names):
    from django.db.migrations.executor import MigrationExecutor

    before = [("issues", "0016_attachment_size_and_type_checks")]
    executor = MigrationExecutor(connection)
    executor.migrate(before)
    Old = executor.loader.project_state(before).apps.get_model("issues", "Label")
    return [Old.objects.create(workspace_id=workspace.pk, name=n).pk for n in names]


def _migrate_to_latest():
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(executor.loader.graph.leaf_nodes())


@pytest.mark.django_db(transaction=True)
def test_migration_rewrites_names_to_canonical(tenant_a):
    try:
        pks = _rollback_and_insert(tenant_a["workspace"], ["σας", "café"])
    finally:
        _migrate_to_latest()
    assert sorted(Label.objects.filter(pk__in=pks).values_list("name", flat=True)) == ["café", "σασ"]


@pytest.mark.django_db(transaction=True)
def test_migration_reports_collisions_instead_of_merging(tenant_a):
    pks = []
    try:
        pks = _rollback_and_insert(tenant_a["workspace"], ["σας", "σασ"])
        with pytest.raises(RuntimeError, match=rf"labels {pks[0]} and {pks[1]}"):
            _migrate_to_latest()
        assert Label.objects.filter(pk__in=pks).count() == 2  # nothing merged or deleted
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM issues_label WHERE id = ANY(%s)", [pks])
        _migrate_to_latest()

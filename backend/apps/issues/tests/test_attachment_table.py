"""Schema review, table #8 (issues_issueattachment): file deletes after commit can't fail the request or skip
each other, the nightly sweep reconciles storage with the table, the per-issue list is capped, and the DB
enforces the size limit and the verified content-type list."""
import logging
import os
import time

import pytest
from django.conf import settings as django_settings
from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.issues.maintenance import sweep_attachment_files
from apps.issues.models import ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, Issue, IssueAttachment
from apps.issues.serializers import IssueAttachmentUploadSerializer
from apps.issues.services import add_attachment
from apps.tenants.models import Workspace

pytestmark = pytest.mark.django_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
OLD = time.time() - 3 * 24 * 3600


@pytest.fixture
def team(tenant_a, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    ws = tenant_a["workspace"]
    ws.plan = Workspace.Plan.ENTERPRISE
    ws.save(update_fields=["plan"])
    issue = Issue.objects.create(project=tenant_a["project"], title="files")
    return {**tenant_a, "issue": issue, "client": None}


def owner(api, team):
    return api(team["owner"], team["workspace"])


def attach(team, name="a.txt", content=b"x", **extra):
    return IssueAttachment.objects.create(
        workspace=team["workspace"], issue=team["issue"], uploaded_by=team["owner"], original_name=name,
        content_type=extra.pop("content_type", "text/plain"), size=len(content),
        file=SimpleUploadedFile(name, content), **extra)


# ------------------------------------------------ 1. deletes after commit are robust

class TestRobustFileDelete:
    def test_storage_error_after_commit_is_logged_not_a_500(self, api, team, monkeypatch, caplog,
                                                              django_capture_on_commit_callbacks):
        attachment = attach(team)
        monkeypatch.setattr(FileSystemStorage, "delete", lambda self, name: (_ for _ in ()).throw(OSError("locked")))
        with caplog.at_level(logging.ERROR), django_capture_on_commit_callbacks(execute=True):
            res = owner(api, team).delete(f"/api/attachments/{attachment.pk}/")
        assert res.status_code == 204
        assert not IssueAttachment.objects.filter(pk=attachment.pk).exists()
        assert "orphan sweep will retry" in caplog.text

    def test_one_failure_does_not_skip_the_other_files(self, api, team, monkeypatch,
                                                       django_capture_on_commit_callbacks):
        first, second = attach(team, "first.txt"), attach(team, "second.txt")
        storage = second.file.storage
        real_delete = FileSystemStorage.delete

        def flaky(self, name):
            if name == first.file.name:
                raise OSError("locked")
            return real_delete(self, name)

        monkeypatch.setattr(FileSystemStorage, "delete", flaky)
        with django_capture_on_commit_callbacks(execute=True) as callbacks:
            res = owner(api, team).delete(f"/api/issues/{team['issue'].key}/")
        assert res.status_code == 204
        assert sum(c.__name__ == "delete_file" for c in callbacks) == 2  # one callback per attachment
        assert storage.exists(first.file.name) and not storage.exists(second.file.name)

    def test_failed_upload_cleanup_never_hides_the_real_error(self, team, monkeypatch):
        monkeypatch.setattr(IssueAttachment, "save", lambda self, *a, **k: (_ for _ in ()).throw(ValueError("db")))
        monkeypatch.setattr(FileSystemStorage, "delete", lambda self, name: (_ for _ in ()).throw(OSError("disk")))
        upload = SimpleUploadedFile("a.txt", b"hello", content_type="text/plain")
        with pytest.raises(ValueError, match="db"):
            add_attachment(team["issue"], team["owner"], upload, record=lambda a: None)


# ------------------------------------------------------- 2. reconciliation sweep

class TestSweep:
    @pytest.fixture
    def storage(self, tmp_path):
        return FileSystemStorage(location=tmp_path)

    @staticmethod
    def put(storage, name, age=OLD):
        storage.save(name, SimpleUploadedFile("f", b"data"))
        os.utime(storage.path(name), (age, age))
        return name

    def test_deletes_only_old_unreferenced_files_under_issues(self, team, storage):
        kept = attach(team)  # referenced: stored through the same MEDIA_ROOT
        os.utime(storage.path(kept.file.name), (OLD, OLD))
        orphan = self.put(storage, "issues/2026/01/orphan.txt")
        fresh = self.put(storage, "issues/2026/11/fresh.txt", age=time.time())
        outside = self.put(storage, "avatars/someone.png")

        stats = sweep_attachment_files(storage=storage)
        assert not storage.exists(orphan)
        assert storage.exists(kept.file.name) and storage.exists(fresh) and storage.exists(outside)
        assert stats["orphans_deleted"] == 1 and stats["skipped_recent"] == 1 and stats["complete"]

    def test_uses_storage_time_not_the_path_date(self, team, storage):
        # The path says 2020 but the file was written a minute ago: still inside the grace period.
        name = self.put(storage, "issues/2020/01/new.txt", age=time.time() - 60)
        sweep_attachment_files(storage=storage)
        assert storage.exists(name)

    def test_small_batches_rerun_safe_and_failures_counted(self, team, storage, monkeypatch):
        names = [self.put(storage, f"issues/2026/01/o{i}.txt") for i in range(5)]
        real_delete = FileSystemStorage.delete
        monkeypatch.setattr(FileSystemStorage, "delete",
                            lambda self, n: (_ for _ in ()).throw(OSError()) if n == names[0] else real_delete(self, n))
        first = sweep_attachment_files(storage=storage, batch_size=2)
        assert first["orphans_deleted"] == 4 and first["delete_failures"] == 1
        monkeypatch.setattr(FileSystemStorage, "delete", real_delete)
        second = sweep_attachment_files(storage=storage, batch_size=2)
        assert second["orphans_deleted"] == 1 and not storage.exists(names[0])
        assert sweep_attachment_files(storage=storage)["orphans_deleted"] == 0

    def test_bounded_run_reports_incomplete(self, team, storage):
        for i in range(3):
            self.put(storage, f"issues/2026/01/o{i}.txt")
        assert sweep_attachment_files(storage=storage, max_files=2)["complete"] is False

    def test_rows_with_missing_files_are_reported_not_deleted(self, team, storage, caplog):
        lost = attach(team)
        IssueAttachment.objects.filter(pk=lost.pk).update(created_at=timezone.now() - timezone.timedelta(days=2))
        storage.delete(lost.file.name)
        with caplog.at_level(logging.WARNING):
            stats = sweep_attachment_files(storage=storage)
        assert stats["missing_files"] == 1 and stats["missing_sample"] == [lost.pk]
        assert IssueAttachment.objects.filter(pk=lost.pk).exists()
        assert "missing files" in caplog.text

    def test_scheduled_nightly(self):
        tasks = {entry["task"] for entry in django_settings.CELERY_BEAT_SCHEDULE.values()}
        assert "apps.automation.tasks.sweep_attachment_files" in tasks


# ------------------------------------------------------------- 3. capped list

def test_list_is_newest_200_then_pages_of_50(api, team):
    IssueAttachment.objects.bulk_create([
        IssueAttachment(workspace=team["workspace"], issue=team["issue"], uploaded_by=team["owner"],
                        original_name=f"{i}.txt", content_type="text/plain", size=1, file=f"issues/x/{i}.txt")
        for i in range(201)
    ])
    expected = list(IssueAttachment.objects.filter(issue=team["issue"]).order_by("-created_at", "-id")
                    .values_list("pk", flat=True))
    res = owner(api, team).get(f"/api/issues/{team['issue'].key}/attachments/")
    assert res.status_code == 200 and res["X-Truncated"] == "true"
    assert [a["id"] for a in res.data] == expected[:200]
    page = owner(api, team).get(f"/api/issues/{team['issue'].key}/attachments/?page=2")
    assert page.data["count"] == 201 and [a["id"] for a in page.data["results"]] == expected[50:100]


def test_small_list_is_a_plain_array_without_truncation(api, team):
    attach(team)
    res = owner(api, team).get(f"/api/issues/{team['issue'].key}/attachments/")
    assert isinstance(res.data, list) and len(res.data) == 1 and "X-Truncated" not in res


# --------------------------------------------------------------- 4. DB CHECKs

class TestChecks:
    def test_size_limit_matches_the_upload_hard_limit(self):
        assert ATTACHMENT_MAX_BYTES == django_settings.FILE_UPLOAD_HARD_LIMIT == 104_857_600

    def test_size_limit_enforced_by_the_db(self, team):
        row = attach(team)
        IssueAttachment.objects.filter(pk=row.pk).update(size=ATTACHMENT_MAX_BYTES)
        with pytest.raises(IntegrityError), transaction.atomic():
            IssueAttachment.objects.filter(pk=row.pk).update(size=ATTACHMENT_MAX_BYTES + 1)

    def test_content_type_list_enforced_by_the_db(self, team):
        row = attach(team)
        for allowed in ATTACHMENT_CONTENT_TYPES:
            IssueAttachment.objects.filter(pk=row.pk).update(content_type=allowed)
        for bad in ("application/octet-stream", "text/html", "image/svg+xml", "", "application/vnd.ms-excel"):
            with pytest.raises(IntegrityError), transaction.atomic():
                IssueAttachment.objects.filter(pk=row.pk).update(content_type=bad)

    def test_db_list_is_exactly_what_uploads_store(self):
        assert set(IssueAttachmentUploadSerializer.ALLOWED_TYPES) == set(ATTACHMENT_TYPES)
        for extension, stored in ATTACHMENT_TYPES.items():
            assert stored in IssueAttachmentUploadSerializer.ALLOWED_TYPES[extension]
        with connection.cursor() as cur:
            cur.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                        "WHERE conname = 'ck_attachment_content_type_allowed'")
            definition = cur.fetchone()[0]
        assert all(f"'{t}'" in definition for t in ATTACHMENT_CONTENT_TYPES)

    @pytest.mark.parametrize("name, content, stored", [
        ("data.csv", b"a,b\n1,2\n", "text/csv"),
        ("archive.zip", b"PK\x05\x06" + b"\x00" * 18, "application/zip"),
        ("notes.md", b"# hi", "text/markdown"),
        ("pic.png", PNG, "image/png"),
    ])
    def test_upload_stores_the_canonical_type(self, api, team, name, content, stored):
        res = owner(api, team).post(f"/api/issues/{team['issue'].key}/attachments/",
                                    {"file": SimpleUploadedFile(name, content, content_type="application/octet-stream")},
                                    format="multipart")
        assert res.status_code == 201, res.data
        assert res.data["content_type"] == stored


# --------------------------------------------------- 5. migration of existing rows

def _rollback_and_insert(content_type, team):
    from django.db.migrations.executor import MigrationExecutor

    before = [("issues", "0015_comment_body_max")]
    executor = MigrationExecutor(connection)
    executor.migrate(before)
    Old = executor.loader.project_state(before).apps.get_model("issues", "IssueAttachment")
    return Old.objects.create(workspace_id=team["workspace"].pk, issue_id=team["issue"].pk, file="issues/x/old.csv",
                              original_name="old.csv", content_type=content_type, size=4).pk


def _migrate_to_latest():
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(executor.loader.graph.leaf_nodes())


@pytest.mark.django_db(transaction=True)
def test_migration_maps_old_alias_types(team):
    try:
        pk = _rollback_and_insert("application/vnd.ms-excel", team)
    finally:
        _migrate_to_latest()
    assert IssueAttachment.objects.get(pk=pk).content_type == "text/csv"


@pytest.mark.django_db(transaction=True)
def test_migration_stops_with_ids_on_unknown_types(team):
    pk = None
    try:
        pk = _rollback_and_insert("application/octet-stream", team)
        with pytest.raises(RuntimeError, match=str(pk)):
            _migrate_to_latest()
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM issues_issueattachment WHERE id = %s", [pk])
        _migrate_to_latest()

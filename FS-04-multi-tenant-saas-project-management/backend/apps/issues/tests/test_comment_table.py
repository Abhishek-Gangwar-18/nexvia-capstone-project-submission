"""Schema review, table #7 (issues_issuecomment): body limit enforced by the DB as well, counted in
characters (code points) exactly like the serializer, and cleanly reported by the admin form."""
import pytest
from django.contrib.admin.sites import site
from django.db import DataError, IntegrityError, transaction

from apps.issues.models import Issue, IssueComment

pytestmark = pytest.mark.django_db

# 'é' is 2 bytes in UTF-8 and '😀' is 4: the limit is about characters, not bytes.
CASES = [("ascii", "a"), ("accented", "é"), ("emoji", "😀")]


@pytest.fixture
def thread(api, tenant_a):
    issue = Issue.objects.create(project=tenant_a["project"], title="thread")
    return {**tenant_a, "issue": issue, "client": api(tenant_a["owner"], tenant_a["workspace"])}


def post(thread, body):
    return thread["client"].post(f"/api/issues/{thread['issue'].key}/comments/", {"body": body}, format="json")


@pytest.mark.parametrize("label, char", CASES)
def test_api_limit_is_10000_characters(thread, label, char):
    accepted = post(thread, char * 10_000)
    assert accepted.status_code == 201, (label, accepted.data)
    assert len(IssueComment.objects.get(pk=accepted.data["id"]).body) == 10_000
    rejected = post(thread, char * 10_001)
    assert rejected.status_code == 400 and "body" in rejected.data, label


@pytest.mark.parametrize("label, char", CASES)
def test_db_counts_characters_like_the_serializer(thread, label, char):
    comment = IssueComment.objects.create(issue=thread["issue"], author=thread["owner"], body="ok")
    IssueComment.objects.filter(pk=comment.pk).update(body=char * 10_000)  # exactly at the limit: fine
    with pytest.raises((IntegrityError, DataError)), transaction.atomic():
        IssueComment.objects.filter(pk=comment.pk).update(body=char * 10_001)


def test_existing_comments_unaffected_and_edits_still_work(thread):
    created = post(thread, "first version")
    res = thread["client"].patch(f"/api/issues/{thread['issue'].key}/comments/{created.data['id']}/",
                                 {"body": "edited " + "x" * 9_000}, format="json")
    assert res.status_code == 200
    too_long = thread["client"].patch(f"/api/issues/{thread['issue'].key}/comments/{created.data['id']}/",
                                      {"body": "x" * 10_001}, format="json")
    assert too_long.status_code == 400
    assert IssueComment.objects.get(pk=created.data["id"]).body.startswith("edited ")


def test_admin_form_reports_a_clean_error(thread, rf):
    """The admin uses the model form (no custom save), so the limit is a field error, not an IntegrityError."""
    admin = site._registry[IssueComment]
    request = rf.get("/")
    request.user = thread["owner"]
    thread["owner"].is_staff = thread["owner"].is_superuser = True
    form_class = admin.get_form(request)
    form = form_class(data={
        "workspace": thread["workspace"].pk, "issue": thread["issue"].pk, "author": thread["owner"].pk,
        "body": "x" * 10_001,
    })
    assert not form.is_valid()
    assert "body" in form.errors and "10000" in str(form.errors["body"])

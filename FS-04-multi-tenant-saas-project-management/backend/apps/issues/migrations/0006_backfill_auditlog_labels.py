from django.db import migrations
from django.db.models import F, Value
from django.db.models.functions import Concat, Substr


def backfill(apps, schema_editor):
    AuditLog = apps.get_model("issues", "AuditLog")
    AuditLog.objects.filter(entity_label="").update(
        entity_label=Substr(Concat(F("issue_key"), Value(" "), F("issue_title")), 1, 255)
    )
    for log in AuditLog.objects.filter(project_key="", project__isnull=False).select_related("project"):
        AuditLog.objects.filter(pk=log.pk).update(project_key=log.project.key)


class Migration(migrations.Migration):
    dependencies = [("issues", "0005_rename_issues_issu_workspa_2da62b_idx_issues_audi_workspa_53d3e4_idx_and_more")]

    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]

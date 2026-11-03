from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("issues", "0003_issueattachment_issuecomment_issueauditlog")]

    operations = [migrations.RenameModel("IssueAuditLog", "AuditLog")]

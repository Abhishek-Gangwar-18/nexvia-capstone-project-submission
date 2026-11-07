import django.db.models.functions.text
from django.conf import settings
from django.contrib.postgres.operations import TrigramExtension
from django.db import migrations, models

# ?search= uses icontains, which PostgreSQL runs as UPPER(col) LIKE UPPER('%term%'). These indexes are on
# exactly those expressions. Raw SQL because Django renders OpClass(Upper(...)) with invalid parentheses.
FIELDS = ("key", "title", "description")
CREATE = [
    f'CREATE INDEX IF NOT EXISTS issue_{field}_trgm ON issues_issue USING gin ((UPPER("{field}")) gin_trgm_ops)'
    for field in FIELDS
]
DROP = [f"DROP INDEX IF EXISTS issue_{field}_trgm" for field in FIELDS]


def lowercase_labels(apps, schema_editor):
    """Older rows may predate lowercase storage."""
    Label = apps.get_model("issues", "Label")
    for label in Label.objects.all():
        if label.name != label.name.lower():
            label.name = label.name.lower()
            label.save(update_fields=["name"])


class Migration(migrations.Migration):

    dependencies = [
        ("issues", "0008_alter_auditlog_action"),
        ("projects", "0002_project_key_canonical_and_wip_cleanup"),
        ("tenants", "0004_invitation_unique_open_invitation"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # CREATE EXTENSION IF NOT EXISTS pg_trgm. Ships with postgres:16-alpine and is trusted since PG 13,
        # so the database owner can create it. If it's unavailable this fails loudly rather than skipping.
        TrigramExtension(),
        migrations.RunSQL(CREATE, DROP),
        migrations.RunPython(lowercase_labels, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="label",
            constraint=models.CheckConstraint(
                condition=models.Q(("name", django.db.models.functions.text.Lower("name"))),
                name="label_name_lowercase",
            ),
        ),
    ]

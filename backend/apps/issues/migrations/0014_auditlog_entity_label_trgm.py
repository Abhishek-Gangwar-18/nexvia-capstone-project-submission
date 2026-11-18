from django.db import migrations

# ?search= on the audit log runs icontains on entity_label, i.e. UPPER(entity_label) LIKE UPPER('%term%').
# This index is on exactly that expression (raw SQL: Django renders OpClass(Upper(...)) with invalid
# parentheses, see 0009). The pg_trgm extension is created in 0009, which this migration depends on.
INDEX = "auditlog_entity_label_trgm"


class Migration(migrations.Migration):

    dependencies = [
        ("issues", "0013_auditlog_history_reference_no_updated_at"),
    ]

    operations = [
        migrations.RunSQL(
            sql=f'CREATE INDEX IF NOT EXISTS {INDEX} ON issues_auditlog USING gin ((UPPER("entity_label")) gin_trgm_ops)',
            reverse_sql=f"DROP INDEX IF EXISTS {INDEX}",
        ),
    ]

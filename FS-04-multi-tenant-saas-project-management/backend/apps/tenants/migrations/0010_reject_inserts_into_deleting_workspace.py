from django.db import migrations

# Once a workspace is marked deleting_at, no new row may be created in it, whatever the write path (API, Celery,
# admin, bulk_create, raw SQL). Every INSERT into a workspace table locks the workspace row FOR KEY SHARE and
# reads deleting_at:
#   * the deletion request marks the row under FOR UPDATE, which conflicts with FOR KEY SHARE, so the mark waits
#     until every insert already in progress has committed (those finished BEFORE deletion began: correct 201s,
#     and the purge removes their rows);
#   * an insert arriving after the mark waits for it if needed, then sees deleting_at and fails with SQLSTATE
#     FB001, which the API turns into the same 404 a later request gets.
# FOR KEY SHARE is the lock the (deferred) workspace FK check already takes at commit, so this adds no new kind of
# contention. INSERT only: the purge itself UPDATEs rows (SET NULL on self-references) while deleting.
# A test asserts that every model with a workspace FK has this trigger, so a new table can't be forgotten.
TABLES = [
    "automation_notification", "automation_webhookdelivery", "automation_webhookendpoint",
    "automation_workspacereport", "billing_subscription", "issues_auditlog", "issues_issue",
    "issues_issueattachment", "issues_issuecomment", "issues_label", "projects_board", "projects_project",
    "projects_sprint", "projects_workflow", "projects_workflowstatus", "projects_workflowtransition",
    "tenants_invitation", "tenants_membership",
]
TRIGGER = "trg_reject_insert_into_deleting_workspace"
# A row's tenant never changes: no code path moves rows between workspaces. Enforced here, so a raw
# UPDATE ... SET workspace_id can't move a row into another tenant, or into a workspace being deleted
# (which would bypass the INSERT guard above).
IMMUTABLE_TRIGGER = "trg_workspace_id_immutable"
IMMUTABLE_FUNCTION = """
CREATE OR REPLACE FUNCTION reject_workspace_id_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'workspace_id of % is immutable (% -> %)', TG_TABLE_NAME, OLD.workspace_id, NEW.workspace_id
        USING ERRCODE = 'FB002';
END;
$$ LANGUAGE plpgsql;
"""

FUNCTION = """
CREATE OR REPLACE FUNCTION reject_insert_into_deleting_workspace() RETURNS trigger AS $$
DECLARE
    marked timestamptz;
BEGIN
    SELECT deleting_at INTO marked FROM tenants_workspace WHERE id = NEW.workspace_id FOR KEY SHARE;
    IF marked IS NOT NULL THEN
        RAISE EXCEPTION 'workspace % is being deleted', NEW.workspace_id USING ERRCODE = 'FB001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

CREATE = FUNCTION + "".join(
    f"CREATE TRIGGER {TRIGGER} BEFORE INSERT ON {table} "
    f"FOR EACH ROW EXECUTE FUNCTION reject_insert_into_deleting_workspace();\n"
    for table in TABLES
)
CREATE += IMMUTABLE_FUNCTION + "".join(
    f"CREATE TRIGGER {IMMUTABLE_TRIGGER} BEFORE UPDATE OF workspace_id ON {table} FOR EACH ROW "
    f"WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id) EXECUTE FUNCTION reject_workspace_id_change();\n"
    for table in TABLES
)
DROP = "".join(f"DROP TRIGGER IF EXISTS {IMMUTABLE_TRIGGER} ON {table};\n" for table in TABLES) + (
    "DROP FUNCTION IF EXISTS reject_workspace_id_change();\n"
) + "".join(f"DROP TRIGGER IF EXISTS {TRIGGER} ON {table};\n" for table in TABLES) + (
    "DROP FUNCTION IF EXISTS reject_insert_into_deleting_workspace();"
)


class Migration(migrations.Migration):

    dependencies = [
        ("tenants", "0009_workspace_deleting_at_slug_name_checks"),
        ("automation", "0005_drop_redundant_indexes"),
        ("billing", "0003_stripeevent_drop_updated_at"),
        ("issues", "0017_label_canonical_names_not_blank"),
        ("projects", "0004_project_name_description_checks_drop_ws_index"),
    ]

    operations = [migrations.RunSQL(CREATE, DROP)]

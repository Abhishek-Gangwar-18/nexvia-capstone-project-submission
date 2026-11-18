import hashlib

import apps.tenants.models
from django.db import migrations, models
from django.db.models import Q
from django.db.models.functions import Lower


def hash_tokens_and_lowercase_emails(apps, schema_editor):
    """Keep every pending link working: store sha256(existing token) instead of the token itself.
    Lowercasing can't create duplicates, because the old unique index was already on lower(email)."""
    Invitation = apps.get_model("tenants", "Invitation")
    for invitation in Invitation.objects.all().only("id", "token", "email"):
        invitation.token_hash = hashlib.sha256(invitation.token.encode()).hexdigest()
        invitation.email = invitation.email.strip().lower()
        invitation.save(update_fields=["token_hash", "email"])


class Migration(migrations.Migration):

    dependencies = [
        ("tenants", "0007_membership_no_default_ordering"),
    ]

    operations = [
        migrations.AddField(
            model_name="invitation",
            name="token_hash",
            field=models.CharField(editable=False, max_length=64, null=True),
        ),
        migrations.RunPython(hash_tokens_and_lowercase_emails, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="invitation",
            name="token_hash",
            field=models.CharField(default=apps.tenants.models.unusable_token_hash, editable=False, max_length=64),
        ),
        migrations.RemoveConstraint(model_name="invitation", name="unique_open_invitation"),
        # Drops the plaintext column together with its unique and varchar_pattern_ops indexes.
        migrations.RemoveField(model_name="invitation", name="token"),
        migrations.AddConstraint(
            model_name="invitation",
            constraint=models.UniqueConstraint(
                condition=Q(("accepted_at__isnull", True)), fields=("workspace", "email"), name="unique_open_invitation"
            ),
        ),
        migrations.AddConstraint(
            model_name="invitation",
            constraint=models.CheckConstraint(condition=Q(("email", Lower("email"))), name="ck_invitation_email_lowercase"),
        ),
        migrations.AddConstraint(
            model_name="invitation",
            constraint=models.UniqueConstraint(fields=("token_hash",), name="uq_invitation_token_hash"),
        ),
    ]

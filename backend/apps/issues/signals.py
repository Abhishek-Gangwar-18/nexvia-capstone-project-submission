from django.core.exceptions import ValidationError
from django.db.models.signals import m2m_changed, post_delete
from django.dispatch import receiver

from apps.projects.models import Project
from apps.tenants.models import Membership

from .models import Issue, IssueAttachment, Label


@receiver(m2m_changed, sender=Issue.labels.through)
def labels_stay_in_workspace(sender, instance, action, pk_set, reverse, **kwargs):
    """M2M writes bypass Model.save(), so guard label attachment separately."""
    if action != "pre_add" or not pk_set:
        return
    if reverse:
        # label.issues.add(...): instance is the Label, pk_set are issue ids
        foreign = Issue.objects.filter(pk__in=pk_set).exclude(workspace_id=instance.workspace_id)
    else:
        foreign = Label.objects.filter(pk__in=pk_set).exclude(workspace_id=instance.workspace_id)
    if foreign.exists():
        raise ValidationError("Labels and issues must belong to the same workspace.")


@receiver(post_delete, sender=Membership)
def release_work_of_removed_member(sender, instance, **kwargs):
    """Someone who left can't own open work: unassign them and clear them as project lead."""
    Issue.objects.filter(workspace_id=instance.workspace_id, assignee_id=instance.user_id).update(assignee=None)
    Project.objects.filter(workspace_id=instance.workspace_id, lead_id=instance.user_id).update(lead=None)


@receiver(post_delete, sender=IssueAttachment)
def remove_attachment_file(sender, instance, **kwargs):
    if instance.file:
        instance.file.delete(save=False)

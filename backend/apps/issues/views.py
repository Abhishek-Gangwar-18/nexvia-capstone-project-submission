from drf_spectacular.utils import extend_schema
from rest_framework import exceptions
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api import TenantModelViewSet
from apps.tenants.models import Membership

from .filters import IssueFilter
from .models import Issue, Label
from .serializers import (
    IssueDetailSerializer, IssueListSerializer, IssueMoveSerializer, IssueSerializer, LabelSerializer,
)
from .services import UNSET, move_issue

Role = Membership.Role


class IssueViewSet(TenantModelViewSet):
    queryset = Issue.objects.all()
    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z][A-Za-z0-9]*-\d+"
    filterset_class = IssueFilter
    search_fields = ["key", "title", "description"]
    ordering_fields = ["rank", "created_at", "updated_at", "priority", "due_date", "number", "story_points"]
    ordering = ["rank", "id"]

    def get_queryset(self):
        return (
            super().get_queryset()
            .select_related("project", "status", "sprint", "parent", "assignee", "reporter")
            .prefetch_related("labels")
        )

    def get_serializer_class(self):
        if self.action == "list":
            return IssueListSerializer
        if self.action == "retrieve":
            return IssueDetailSerializer
        return IssueSerializer

    def get_object(self):
        self.kwargs[self.lookup_field] = self.kwargs[self.lookup_field].upper()
        return super().get_object()

    def perform_create(self, serializer):
        serializer.save(workspace=self.workspace, reporter=self.request.user)

    def perform_destroy(self, instance):
        if instance.reporter_id != self.request.user.id and not self.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only the reporter or a workspace admin can delete this issue.")
        instance.delete()

    @extend_schema(request=IssueMoveSerializer, responses=IssueSerializer)
    @action(detail=True, methods=["post"])
    def move(self, request, key=None):
        issue = self.get_object()
        payload = IssueMoveSerializer(data=request.data, context=self.get_serializer_context())
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        move_issue(
            issue,
            status=data.get("status"),
            sprint=data["sprint"] if "sprint" in data else UNSET,
            prev_id=data.get("prev_id"),
            next_id=data.get("next_id"),
        )
        return Response(IssueSerializer(self.get_queryset().get(pk=issue.pk), context=self.get_serializer_context()).data)


class LabelViewSet(TenantModelViewSet):
    queryset = Label.objects.all()
    serializer_class = LabelSerializer
    required_roles = {"destroy": Role.ADMIN}
    search_fields = ["name"]

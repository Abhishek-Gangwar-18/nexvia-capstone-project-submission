"""
Request-level tenant isolation for the REST API.

`WorkspaceScopedMixin` runs right after authentication and before permission checks:
it reads the `X-Workspace` header, verifies the caller is a member of that workspace, then binds
`request.workspace` / `request.membership` and the tenant ContextVar. Every queryset in a
`TenantModelViewSet` is filtered through `for_workspace()`, so rows from other tenants are
unreachable — not just hidden — and a foreign id yields 404 rather than 403.
"""
from rest_framework import exceptions, viewsets
from rest_framework.permissions import IsAuthenticated

from apps.tenants.models import Membership

from .context import set_current_workspace
from .permissions import HasWorkspaceRole
from .request_logging import bind_log_context


class WorkspaceScopedMixin:
    permission_classes = [IsAuthenticated, HasWorkspaceRole]

    def check_permissions(self, request):
        if request.user and request.user.is_authenticated:
            self.resolve_workspace(request)
        super().check_permissions(request)

    def resolve_workspace(self, request):
        slug = request.META.get("HTTP_X_WORKSPACE") or request.query_params.get("workspace")
        if not slug:
            raise exceptions.ValidationError({"workspace": "The X-Workspace header is required."})
        if "\x00" in slug:  # PostgreSQL can't store NUL, so no workspace can match it
            raise exceptions.NotFound("Workspace not found.")
        membership = (
            Membership.objects.select_related("workspace")
            .filter(user=request.user, workspace__slug=slug)
            .first()
        )
        if membership is None:
            # Same response whether the workspace doesn't exist or the user isn't in it.
            raise exceptions.NotFound("Workspace not found.")
        for target in (request, request._request):
            target.workspace = membership.workspace
            target.membership = membership
        set_current_workspace(membership.workspace)  # TenantMiddleware resets it after the response
        # From here on, every log line of this request names the tenant and the user.
        bind_log_context(tenant=membership.workspace.slug, user_id=str(request.user.pk))

    @property
    def workspace(self):
        return getattr(self.request, "workspace", None)

    @property
    def membership(self):
        return getattr(self.request, "membership", None)


class TenantModelViewSet(WorkspaceScopedMixin, viewsets.ModelViewSet):
    def get_queryset(self):
        return super().get_queryset().for_workspace(self.workspace)

    def perform_create(self, serializer):
        serializer.save(workspace=self.workspace)

from drf_spectacular.openapi import AutoSchema
from drf_spectacular.utils import OpenApiParameter


class TenantAutoSchema(AutoSchema):
    """Documents the X-Workspace header on every workspace-scoped endpoint."""

    def get_override_parameters(self):
        from .api import WorkspaceScopedMixin

        params = super().get_override_parameters()
        if isinstance(self.view, WorkspaceScopedMixin):
            params = [
                *params,
                OpenApiParameter(
                    "X-Workspace", str, OpenApiParameter.HEADER, required=True, description="Workspace slug"
                ),
            ]
        return params

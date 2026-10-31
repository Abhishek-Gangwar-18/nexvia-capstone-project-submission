from .context import reset_current_workspace, set_current_workspace


class TenantMiddleware:
    """
    Captures which workspace the client is asking for and guarantees a clean tenant context per
    request. The slug is *not trusted* here: JWT auth runs later inside DRF, so the API layer
    resolves `request.workspace_slug` and checks membership before binding the workspace.
    """

    header = "HTTP_X_WORKSPACE"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.workspace_slug = request.META.get(self.header) or request.GET.get("workspace")
        request.workspace = None
        request.membership = None
        token = set_current_workspace(None)
        try:
            return self.get_response(request)
        finally:
            reset_current_workspace(token)

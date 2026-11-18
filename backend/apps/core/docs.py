"""OpenAPI schema and Swagger UI, gated by settings.API_DOCS (checked on every request):

  "public": anyone (local development: the default when DEBUG=True, and the local Docker stack)
  "staff":  authenticated staff only: a Django admin session, or a JWT of a user with is_staff
  "off":    404, as if the routes didn't exist (the production default)
"""
from django.conf import settings
from django.http import Http404
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework_simplejwt.authentication import JWTAuthentication


class _GatedDocsMixin:
    def initial(self, request, *args, **kwargs):
        if settings.API_DOCS == "off":
            raise Http404
        super().initial(request, *args, **kwargs)

    def get_authenticators(self):
        return [SessionAuthentication(), JWTAuthentication()]

    def get_permissions(self):
        return [AllowAny()] if settings.API_DOCS == "public" else [IsAdminUser()]


class SchemaView(_GatedDocsMixin, SpectacularAPIView):
    pass


class SwaggerView(_GatedDocsMixin, SpectacularSwaggerView):
    pass

from django.contrib import admin
from django.contrib.admin.forms import AdminAuthenticationForm
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.core.exceptions import ValidationError

from . import lockout
from .models import User
from .serializers import normalize_email



class LockoutAdminAuthenticationForm(AdminAuthenticationForm):
    """The admin login shares the API's per-account lockout (Redis-backed, apps/accounts/lockout.py): 10 failed
    attempts in 15 minutes lock the account on both entry points. Per-IP limits are nginx's job (limit_req)."""

    error_messages = {
        **AdminAuthenticationForm.error_messages,
        "locked": "Too many failed login attempts for this account. Try again in 15 minutes.",
    }

    def clean(self):
        email = normalize_email(self.data.get("username") or "")
        if email and lockout.is_locked(email):
            raise ValidationError(self.error_messages["locked"], code="locked")
        try:
            cleaned = super().clean()
        except ValidationError:
            if email and self.user_cache is None:  # wrong credentials (not "valid user, but not staff")
                lockout.record_failure(email)
            raise
        if email:
            lockout.clear(email)
        return cleaned


admin.site.login_form = LockoutAdminAuthenticationForm


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    ordering = ["email"]
    list_display = ["email", "first_name", "last_name", "job_title", "is_staff", "date_joined"]
    search_fields = ["email", "first_name", "last_name"]
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("first_name", "last_name", "job_title", "avatar_color")}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (None, {"classes": ("wide",), "fields": ("email", "password1", "password2")}),
    )

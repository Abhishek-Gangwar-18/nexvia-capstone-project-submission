from django.contrib import admin

from .models import Invitation, Membership, Workspace


@admin.register(Invitation)
class InvitationAdmin(admin.ModelAdmin):
    list_display = ["email", "workspace", "role", "invited_by", "expires_at", "accepted_at"]
    list_filter = ["workspace", "role"]
    search_fields = ["email"]


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0
    autocomplete_fields = ["user"]
    ordering = ["user__email"]


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "owner", "plan", "created_at"]
    list_filter = ["plan"]
    search_fields = ["name", "slug"]
    autocomplete_fields = ["owner"]
    inlines = [MembershipInline]


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ["user", "workspace", "role", "created_at"]
    ordering = ["workspace__name", "user__email"]
    list_filter = ["role", "workspace"]
    search_fields = ["user__email", "workspace__name"]
    autocomplete_fields = ["user", "workspace"]

from django.apps import AppConfig


class IssuesConfig(AppConfig):
    name = "apps.issues"
    label = "issues"
    verbose_name = "Issues"

    def ready(self):
        from . import signals  # noqa: F401

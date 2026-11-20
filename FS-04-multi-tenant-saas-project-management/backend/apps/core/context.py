"""
Request/task-scoped tenant context.

A ContextVar (not a thread-local) so it is correct under threads, async views and Celery
workers alike. The API layer binds the workspace after authenticating the user and checking
membership; background jobs bind it explicitly with `workspace_context(...)`.
"""
from contextlib import contextmanager
from contextvars import ContextVar

_current_workspace = ContextVar("current_workspace", default=None)


class TenantContextMissing(RuntimeError):
    """Raised when tenant-scoped data is touched without a bound workspace (fail closed)."""


def get_current_workspace():
    return _current_workspace.get()


def set_current_workspace(workspace):
    return _current_workspace.set(workspace)


def reset_current_workspace(token):
    _current_workspace.reset(token)


@contextmanager
def workspace_context(workspace):
    token = set_current_workspace(workspace)
    try:
        yield workspace
    finally:
        reset_current_workspace(token)

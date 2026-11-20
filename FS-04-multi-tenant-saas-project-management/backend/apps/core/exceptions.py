from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError, IntegrityError
from django.db.models import ProtectedError, RestrictedError
from rest_framework import exceptions, status
from rest_framework.views import exception_handler as drf_exception_handler


# Raised by the reject_insert_into_deleting_workspace() trigger (tenants migration 0010).
WORKSPACE_DELETING_SQLSTATE = "FB001"
# Raised by reject_workspace_id_change(): rows never move between workspaces.
WORKSPACE_ID_IMMUTABLE_SQLSTATE = "FB002"
# Raised at commit by the project/workflow constraint triggers (projects migration 0007).
PROJECT_WORKFLOW_SQLSTATE = "FB003"


class Conflict(exceptions.APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This change conflicts with existing data."
    default_code = "conflict"


def exception_handler(exc, context):
    """Model-level guards (tenant integrity, constraints) surface as 400/409 instead of 500."""
    if isinstance(exc, DjangoValidationError):
        detail = exc.message_dict if hasattr(exc, "error_dict") else {"detail": exc.messages}
        exc = exceptions.ValidationError(detail)
    elif isinstance(exc, (IntegrityError, ProtectedError, RestrictedError)):
        exc = Conflict()
    elif isinstance(exc, DatabaseError) and getattr(exc.__cause__, "sqlstate", None) == WORKSPACE_DELETING_SQLSTATE:
        # A write that resolved the workspace just before its deletion began (see apps/tenants/deletion.py):
        # same answer as for any later request to it.
        exc = exceptions.NotFound("Workspace not found.")
    elif isinstance(exc, DatabaseError) and getattr(exc.__cause__, "sqlstate", None) == WORKSPACE_ID_IMMUTABLE_SQLSTATE:
        exc = Conflict("Records can't be moved to another workspace.")
    elif isinstance(exc, DatabaseError) and getattr(exc.__cause__, "sqlstate", None) == PROJECT_WORKFLOW_SQLSTATE:
        exc = Conflict("A project and its workflow are created and deleted together.")
    return drf_exception_handler(exc, context)

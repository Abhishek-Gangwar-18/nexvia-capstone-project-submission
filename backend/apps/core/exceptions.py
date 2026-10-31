from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from rest_framework import exceptions, status
from rest_framework.views import exception_handler as drf_exception_handler


class Conflict(exceptions.APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This change conflicts with existing data."
    default_code = "conflict"


def exception_handler(exc, context):
    """Model-level guards (tenant integrity, constraints) surface as 400/409 instead of 500."""
    if isinstance(exc, DjangoValidationError):
        detail = exc.message_dict if hasattr(exc, "error_dict") else {"detail": exc.messages}
        exc = exceptions.ValidationError(detail)
    elif isinstance(exc, IntegrityError):
        exc = Conflict()
    return drf_exception_handler(exc, context)

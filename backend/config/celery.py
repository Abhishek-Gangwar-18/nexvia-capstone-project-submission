import os

from celery import Celery
from celery.signals import after_setup_logger, after_setup_task_logger, before_task_publish, task_postrun, task_prerun

from apps.core.request_logging import ContextFilter, _log_context, get_log_context

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
app = Celery("flowboard")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

# ---- request id / tenant in worker logs ------------------------------------------------------------
# The request that queues a task sends its log context in a message header; the worker binds it while
# the task runs, so the task's lines carry the same req=/tenant=/user= as the request that caused them.
# Tasks started by beat get req=task-<id>.

LOG_CONTEXT_HEADER = "flowboard_log_context"
CONTEXT_FORMAT = "[req=%(request_id)s tenant=%(tenant)s user=%(user_id)s]"
app.conf.worker_log_format = f"[%(asctime)s: %(levelname)s/%(processName)s] {CONTEXT_FORMAT} %(message)s"
app.conf.worker_task_log_format = (
    f"[%(asctime)s: %(levelname)s/%(processName)s] {CONTEXT_FORMAT} %(task_name)s[%(task_id)s]: %(message)s"
)


@before_task_publish.connect
def attach_log_context(headers=None, **kwargs):
    context = get_log_context()
    if headers is not None and context:
        headers[LOG_CONTEXT_HEADER] = {k: context.get(k) for k in ("request_id", "tenant", "user_id") if context.get(k)}


def _incoming_context(task):
    request = task.request
    context = getattr(request, LOG_CONTEXT_HEADER, None)
    if not context:
        context = (getattr(request, "headers", None) or {}).get(LOG_CONTEXT_HEADER)
    return context if isinstance(context, dict) else {}


_task_tokens = {}


@task_prerun.connect
def bind_task_log_context(task_id=None, task=None, **kwargs):
    # Eager tasks (tests) run inside the request and simply keep its context.
    context = dict(get_log_context()) or {"request_id": f"task-{(task_id or '')[:8]}"}
    if task is not None:
        context.update(_incoming_context(task))
    _task_tokens[task_id] = _log_context.set(context)


@task_postrun.connect
def clear_task_log_context(task_id=None, **kwargs):
    token = _task_tokens.pop(task_id, None)
    if token is not None:
        try:
            _log_context.reset(token)
        except ValueError:  # token from another context; just clear
            _log_context.set(None)


@after_setup_logger.connect
@after_setup_task_logger.connect
def add_context_filter(logger=None, **kwargs):
    for handler in logger.handlers if logger is not None else ():
        if not any(isinstance(f, ContextFilter) for f in handler.filters):
            handler.addFilter(ContextFilter())

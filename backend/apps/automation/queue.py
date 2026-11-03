import logging

logger = logging.getLogger(__name__)


def enqueue(task, *args):
    """Queue a task without letting a broker outage break the request. Returns an error message or None."""
    try:
        task.delay(*args)
    except Exception:
        logger.exception("Could not queue %s%r", task.name, args)
        return "The background queue is unavailable. Try again shortly."
    return None

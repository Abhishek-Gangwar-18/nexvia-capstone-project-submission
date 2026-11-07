"""Webhook signatures.

Each delivery attempt sends:
    X-FlowBoard-Timestamp: <unix seconds>
    X-FlowBoard-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<exact raw body>">
    X-FlowBoard-Delivery:  <event id>   (stable across retries and redeliveries: dedupe on it)

Receivers must compare in constant time and reject timestamps outside the tolerance window, which stops
captured requests from being replayed later. `verify` below is the reference implementation.
"""
import hashlib
import hmac
import time

TOLERANCE_SECONDS = 300


def sign(secret, timestamp, body):
    message = f"{int(timestamp)}.".encode() + body
    return "sha256=" + hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def verify(secret, timestamp_header, body, signature_header, *, now=None, tolerance=TOLERANCE_SECONDS):
    try:
        timestamp = int(timestamp_header)
    except (TypeError, ValueError):
        return False
    now = time.time() if now is None else now
    if abs(now - timestamp) > tolerance:
        return False
    return hmac.compare_digest(sign(secret, timestamp, body), signature_header or "")

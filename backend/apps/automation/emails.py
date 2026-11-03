from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string


def absolute_url(path):
    return f"{settings.FRONTEND_URL.rstrip('/')}{path}"


def send_templated_email(subject, template, context, to):
    """Sends templates/email/<template>.txt plus its .html version. Subjects are flattened to one line."""
    message = EmailMultiAlternatives(
        subject=" ".join(subject.split())[:200],
        body=render_to_string(f"email/{template}.txt", context),
        to=[to],
    )
    message.attach_alternative(render_to_string(f"email/{template}.html", context), "text/html")
    message.send()

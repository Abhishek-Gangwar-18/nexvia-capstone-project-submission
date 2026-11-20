from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class OptionalPageNumberPagination(PageNumberPagination):
    """Paginate only when the client asks for `?page=`; otherwise return a plain list.
    Small collections (projects, sprints, members) stay simple, big ones can page."""

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 500

    def paginate_queryset(self, queryset, request, view=None):
        if self.page_query_param not in request.query_params:
            return None
        return super().paginate_queryset(queryset, request, view)


class AlwaysPageNumberPagination(PageNumberPagination):
    """Always paginated, even without `?page=`: for collections that must never come back whole."""

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


def _stable(queryset):
    """Append the primary key so equal sort values can't shuffle rows across pages or across the cap."""
    ordering = list(queryset.query.order_by) or list(queryset.model._meta.ordering)
    if not any(str(field).lstrip("-") in ("pk", "id") for field in ordering):
        ordering.append("pk")
    return queryset.order_by(*ordering)


class CappedListMixin:
    """Unpaged list responses are capped at PLAIN_LIST_CAP rows. `X-Truncated: true` is set only when
    more rows matched. The requested ordering is kept (plus the pk as a tiebreak), so the cap is predictable."""

    PLAIN_LIST_CAP = 1000

    def list(self, request, *args, **kwargs):
        if self.paginator is not None and self.paginator.page_query_param in request.query_params:
            return super().list(request, *args, **kwargs)
        queryset = _stable(self.filter_queryset(self.get_queryset()))
        rows = list(queryset[: self.PLAIN_LIST_CAP + 1])
        truncated = len(rows) > self.PLAIN_LIST_CAP
        response = Response(self.get_serializer(rows[: self.PLAIN_LIST_CAP], many=True).data)
        if truncated:
            response["X-Truncated"] = "true"
        return response


def paginate_or_cap(view, request, queryset, serializer_class, *, newest_first, cap=200):
    """For nested lists (comments, activity). `?page=` pages 50 at a time (max 200). Without it, the newest
    `cap` rows come back, still in the queryset's own order (comments oldest-first, activity newest-first)."""
    queryset = _stable(queryset)
    if "page" in request.query_params:
        paginator = AlwaysPageNumberPagination()
        page = paginator.paginate_queryset(queryset, request, view=view)
        return paginator.get_paginated_response(serializer_class(page, many=True).data)
    if newest_first:
        rows = list(queryset[: cap + 1])
        truncated, rows = len(rows) > cap, rows[:cap]
    else:
        newest = list(queryset.reverse()[: cap + 1])
        truncated, rows = len(newest) > cap, list(reversed(newest[:cap]))
    response = Response(serializer_class(rows, many=True).data)
    if truncated:
        response["X-Truncated"] = "true"
    return response

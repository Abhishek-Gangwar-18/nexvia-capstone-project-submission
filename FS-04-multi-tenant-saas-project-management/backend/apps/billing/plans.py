"""The plan catalog. `None` means unlimited. Prices live in Stripe and are found by lookup key."""

PLANS = {
    "free": {
        "name": "Free", "price_monthly": 0, "lookup_key": None,
        "projects": 3, "members": 5, "file_mb": 10,
        "features": ["Boards, sprints and custom workflows", "Reports and audit log", "Webhooks and email notifications"],
    },
    "pro": {
        "name": "Pro", "price_monthly": 29, "lookup_key": "flowboard_pro_monthly",
        "projects": 20, "members": 50, "file_mb": 25,
        "features": ["Everything in Free", "More projects and members", "Larger file uploads"],
    },
    "enterprise": {
        "name": "Enterprise", "price_monthly": 99, "lookup_key": "flowboard_enterprise_monthly",
        "projects": None, "members": None, "file_mb": 100,
        "features": ["Everything in Pro", "No project or member limits", "Largest file uploads"],
    },
}

PLAN_BY_LOOKUP_KEY = {plan["lookup_key"]: plan_id for plan_id, plan in PLANS.items() if plan["lookup_key"]}
PAID_PLANS = tuple(PLAN_BY_LOOKUP_KEY.values())


def plan_limits(plan_id):
    return PLANS.get(plan_id, PLANS["free"])

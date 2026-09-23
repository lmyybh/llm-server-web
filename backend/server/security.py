"""Cross-origin write protection.

This is CSRF defence, not authentication. There is no login in v1, so the only
thing standing between a page the user happens to have open and this API is
where the request says it came from.

CORS does **not** cover this. A cross-origin ``POST`` still reaches the server
and its side effects still happen; the browser only withholds the *response*.
So unsafe methods are refused outright when the Origin cannot be accounted for.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

ALLOWED_ORIGINS_ENV = "LLMBENCH_ALLOWED_ORIGINS"


def allowed_origins() -> set[str]:
    """Origins explicitly permitted to write, from the environment.

    Read per call rather than at import, so configuration and tests are not
    fighting over module state.
    """
    raw = os.environ.get(ALLOWED_ORIGINS_ENV, "")
    return {item.strip().rstrip("/") for item in raw.split(",") if item.strip()}


def origin_is_allowed(origin: str | None, host: str | None) -> bool:
    if not origin:
        # Not a browser cross-origin request: curl, a server-side caller, or a
        # same-origin navigation. There is no forgery to defend against.
        return True
    normalized = origin.strip().rstrip("/")
    if normalized in allowed_origins():
        return True
    # Same host, any port. The frontend and the API are separate ports in
    # development, and a page served from this host is not a third party.
    origin_host = _hostname(normalized)
    return origin_host is not None and origin_host == _hostname(host)


def _hostname(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value if "//" in value else f"//{value}")
    return parsed.hostname

"""Runtime configuration."""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_DB_PATH = BACKEND_ROOT / "llmbench.db"

ARTIFACTS_ROOT = BACKEND_ROOT / "artifacts"
"""Raw evidence, one directory per Cell. Kept because the measurement kernel's
definitions may be corrected later, and only the raw material allows the
numbers to be recomputed rather than merely regretted."""

CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

CORS_ORIGIN_REGEX = r"^https?://[^/]+:3000$"
"""Any host, port 3000 — i.e. wherever the Next.js frontend happens to be reached.

The frontend and the API are separate origins in development, and "localhost"
is only correct when the browser is on this machine. Pinning an allowlist to
hostnames would mean editing it every time someone browses from a different
address. Deliberately not ``*``: that would let any page the user has open
reach this API.
"""


def database_path() -> Path:
    return Path(os.environ.get("LLMBENCH_DB", DEFAULT_DB_PATH))

"""Put the backend root on the path so tests can import ``llmbench`` and ``tools``."""

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

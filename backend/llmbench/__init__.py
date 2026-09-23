"""Load generation and measurement for LLM inference services.

This is the measurement kernel of the bench & inspection site: it owns the
concurrency model, arrival scheduling, incremental SSE parsing, per-request
timing, and token accounting. It depends on no external load generator.
"""

__version__ = "0.1.0"

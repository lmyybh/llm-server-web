"""Ask a Target Service what it is, before measuring it.

Only what the plan cannot be built without: the context length. Everything else
the service advertises is interesting but not load-bearing, and guessing it is
worse than not having it.
"""

from __future__ import annotations

import aiohttp


class DiscoveryError(RuntimeError):
    """The service did not tell us something we cannot proceed without."""


async def discover_context_length(
    base_url: str,
    model: str,
    *,
    api_key: str | None = None,
    timeout_seconds: float = 15.0,
) -> int:
    """The model's advertised context length, from ``/v1/models``.

    Fails rather than guesses. A wrong context length silently produces a
    workload catalogue measured against the wrong budget, and every number that
    follows is subtly off — the failure mode this project cares most about.
    """
    url = f"{base_url.rstrip('/')}/v1/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    raise DiscoveryError(
                        f"{url} returned {response.status}; pass the context length explicitly"
                    )
                payload = await response.json()
    except aiohttp.ClientError as exc:
        raise DiscoveryError(f"could not reach {url}: {exc}") from exc
    except ValueError as exc:
        raise DiscoveryError(f"{url} did not return JSON") from exc

    return parse_context_length(payload, model, source=url)


def parse_context_length(payload: object, model: str, *, source: str = "/v1/models") -> int:
    """Pick the context length out of a ``/v1/models`` body.

    Prefers the entry that names our model; falls back to the body's *unique*
    advertised value. That fallback matters in practice: SGLang puts the context
    length on the base model card and LoRA cards may omit it, so a single
    distinct value across all entries is unambiguous.
    """
    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list) or not entries:
        raise DiscoveryError(f"{source} listed no models")

    mine = [e for e in entries if isinstance(e, dict) and e.get("id") == model]
    advertised = _advertised(entries if not mine else mine) or _advertised(entries)

    if len(advertised) == 1:
        return int(advertised.pop())
    if not advertised:
        raise DiscoveryError(
            f"{source} does not advertise max_model_len for {model!r}; "
            "pass the context length explicitly"
        )
    raise DiscoveryError(
        f"{source} advertises several context lengths ({sorted(advertised)}) and "
        f"{model!r} does not disambiguate them; pass the context length explicitly"
    )


def _advertised(entries: list) -> set[int]:
    return {
        value
        for entry in entries
        if isinstance(entry, dict)
        for value in (_positive_int(entry.get("max_model_len")),)
        if value is not None
    }


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and value > 0 else None

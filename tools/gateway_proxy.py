#!/usr/bin/env python3
"""A stand-in for the platform gateway: strips a path prefix, then forwards.

The deployed shape differs from ``npm run dev`` in a way that hides bugs: the
browser addresses everything under a prefix, Next.js only ever sees the path
with that prefix already stripped, and anything the browser navigates to on its
own is the app's responsibility to prefix. Locally every route works; behind the
gateway the same clicks 404.

This makes that shape reproducible on one machine:

    # frontend on :6006 with the gateway prefix, then
    python3 tools/gateway_proxy.py \\
        --prefix /api/gateway/tensorboard/kf-partition/nbser-chengguoliang-gpu \\
        --port 7777 --upstream http://127.0.0.1:6006

    # and browse http://127.0.0.1:7777/<prefix>/

Bodies are buffered rather than streamed — fine for HTML, RSC payloads and
JSON, and deliberately not a production proxy.
"""

from __future__ import annotations

import argparse
import sys

from aiohttp import ClientSession, web

# Connection-level headers belong to the hop, not to the request we forward.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def create_app(prefix: str, upstream: str) -> web.Application:
    upstream = upstream.rstrip("/")

    async def forward(request: web.Request) -> web.Response:
        tail = request.match_info.get("tail", "")
        target = f"{upstream}/{tail}" if tail else f"{upstream}/"
        if request.query_string:
            target = f"{target}?{request.query_string}"

        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in HOP_BY_HOP
        }
        # The app compares the browser's Origin against this to tell a
        # same-site request from a cross-site forgery.
        headers["X-Forwarded-Host"] = request.host

        async with ClientSession() as session:
            async with session.request(
                request.method, target, headers=headers, data=await request.read()
            ) as response:
                body = await response.read()
                return web.Response(
                    body=body,
                    status=response.status,
                    headers={
                        key: value
                        for key, value in response.headers.items()
                        if key.lower() not in HOP_BY_HOP
                    },
                )

    app = web.Application()
    app.router.add_route("*", f"{prefix}/{{tail:.*}}", forward)
    app.router.add_route("*", prefix, forward)
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--prefix", required=True, help="Path prefix to strip.")
    parser.add_argument("--port", type=int, default=7777)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--upstream", default="http://127.0.0.1:6006")
    args = parser.parse_args(argv)

    prefix = "/" + args.prefix.strip("/")
    print(f"stripping {prefix} -> {args.upstream}")
    print(f"browse   http://{args.host}:{args.port}{prefix}/")
    web.run_app(create_app(prefix, args.upstream), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())

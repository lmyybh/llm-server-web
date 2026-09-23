"""Minimal entry point: run one level against a Target Service and print what happened.

This is the seed of the orchestration that will later live behind the web API;
for now it exists so the measurement kernel can be exercised and compared
against a reference implementation.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .loadgen import WARMUP_REQUESTS, LevelResult, run_measured_level


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="llmbench",
        description="Run one load level against a Target Service and report metrics.",
    )
    parser.add_argument("--url", required=True, help="Target Service base URL (router).")
    parser.add_argument("--model", required=True, help="Model name sent to the service.")
    parser.add_argument("--input-tokens", type=int, default=1024, help="Synthetic prompt length in tokens.")
    parser.add_argument("--output-tokens", type=int, default=128, help="Tokens to generate per request.")
    parser.add_argument("--concurrency", type=int, default=8, help="Closed-loop concurrency.")
    parser.add_argument("--num-requests", type=int, default=64, help="Requests in the measured run.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--timeout", type=float, default=600.0, help="Per-request timeout, seconds.")
    return parser


async def run(args: argparse.Namespace) -> LevelResult:
    base_url = args.url.rstrip("/")
    if base_url.endswith("/v1"):
        base_url = base_url[: -len("/v1")]
    print(f"Target       {base_url}")
    print(f"Model        {args.model}")
    print(
        f"Level        concurrency={args.concurrency}  requests={args.num_requests}"
    )
    print(f"Workload     input={args.input_tokens} tokens  output={args.output_tokens} tokens")
    print()
    print(f"warmup ({WARMUP_REQUESTS}) → flush_cache → measured run")
    result = await run_measured_level(
        base_url=base_url,
        model=args.model,
        input_tokens=args.input_tokens,
        output_tokens=args.output_tokens,
        concurrency=args.concurrency,
        num_requests=args.num_requests,
        seed=args.seed,
        timeout_seconds=args.timeout,
    )
    report(result)
    return result


def report(result: LevelResult) -> None:
    print()
    print(f"  requests      {result.total_requests}")
    print(f"  successful    {result.successful_requests}")
    print(f"  failed        {result.failed_requests}")
    print(f"  duration      {result.duration_seconds:.2f} s")
    print(f"  achieved      {result.achieved_qps:.2f} req/s")
    print(f"  output tput   {result.output_token_throughput:.2f} tokens/s")
    print(f"  input  tput   {result.input_token_throughput:.2f} tokens/s")

    print()
    print("  metric      p50        p95        p99")
    for name, values in result.summaries().items():
        row = "  ".join(
            "n/a     " if values[q] is None else f"{values[q]:>9.2f}" for q in ("p50", "p95", "p99")
        )
        print(f"  {name:<10}  {row}")

    reasons = result.finish_reasons()
    if reasons:
        print()
        print(f"  finish reasons   {reasons}")

    errors = result.error_messages()
    if errors:
        print()
        print("  errors")
        for message, count in sorted(errors.items(), key=lambda kv: -kv[1]):
            print(f"    {count:>5}  {message}")

    for title, histogram in (
        ("TTFT distribution (ms)", result.ttft_histogram()),
        ("TPOT distribution (ms)", result.tpot_histogram()),
        ("E2E  distribution (ms)", result.e2e_histogram()),
    ):
        print()
        print(f"  {title}")
        for label, count in histogram.as_dict().items():
            if count:
                print(f"    {label:<16} {count:>5}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0 if result.failed_requests == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

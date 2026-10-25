#!/usr/bin/env python3
"""Fetch real FinNLP/Finnhub news and print the evidence handoff as Markdown.

Start the local service with Docker Compose and set FINNLP_BRIDGE_API_KEY first.
This CLI intentionally does not invent articles or execute workflow decisions.
"""

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ticker", help="Stock symbol, for example AAPL")
    parser.add_argument("start_date", help="Inclusive start date in YYYY-MM-DD format")
    parser.add_argument("end_date", help="Inclusive end date in YYYY-MM-DD format")
    parser.add_argument(
        "--base-url",
        default=os.getenv("FINNLP_BRIDGE_URL", "http://127.0.0.1:8000"),
        help="Bridge base URL (defaults to FINNLP_BRIDGE_URL or localhost)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bridge_key = os.getenv("FINNLP_BRIDGE_API_KEY", "").strip()
    if not bridge_key:
        print("FINNLP_BRIDGE_API_KEY is not set; refusing to send an unauthenticated request.", file=sys.stderr)
        return 2

    parsed = urlsplit(args.base_url)
    is_loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and is_loopback):
        print("The bridge URL must use HTTPS, except for a loopback development URL.", file=sys.stderr)
        return 2
    if not parsed.netloc:
        print("The bridge URL is invalid.", file=sys.stderr)
        return 2

    payload = json.dumps({
        "ticker": args.ticker,
        "start_date": args.start_date,
        "end_date": args.end_date,
    }).encode("utf-8")
    request = Request(
        args.base_url.rstrip("/") + "/execute/news",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + bridge_key,
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=75) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8"))
            detail = body.get("detail", "bridge_request_failed")
        except (ValueError, AttributeError):
            detail = "bridge_request_failed"
        print(f"FinNLP bridge returned HTTP {error.code}: {detail}", file=sys.stderr)
        return 1
    except (URLError, TimeoutError, json.JSONDecodeError):
        print("Unable to retrieve a valid response from the FinNLP bridge. Check its health and provider configuration.", file=sys.stderr)
        return 1

    markdown = result.get("summary_markdown")
    if not isinstance(markdown, str):
        print("FinNLP bridge response did not contain summary_markdown.", file=sys.stderr)
        return 1
    print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import hmac
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator

logger = logging.getLogger("flowwork.finnlp")
app = FastAPI(title="FlowWork FinNLP bridge", version="1.0.0")

MAX_RANGE_DAYS = 31
TICKER_PATTERN = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")


class NewsRequest(BaseModel):
    ticker: str = Field(min_length=1, max_length=10)
    start_date: date
    end_date: date

    @field_validator("ticker")
    @classmethod
    def normalize_ticker(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not TICKER_PATTERN.fullmatch(normalized):
            raise ValueError("ticker must be a valid exchange symbol")
        return normalized

    @model_validator(mode="after")
    def validate_date_range(self) -> "NewsRequest":
        if self.start_date > self.end_date:
            raise ValueError("start_date must be on or before end_date")
        if self.end_date > date.today():
            raise ValueError("end_date cannot be in the future")
        if (self.end_date - self.start_date).days + 1 > MAX_RANGE_DAYS:
            raise ValueError(f"date range cannot exceed {MAX_RANGE_DAYS} calendar days")
        return self


def _require_bridge_key(authorization: str | None) -> None:
    expected = os.getenv("FINNLP_BRIDGE_API_KEY", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="bridge_auth_not_configured")
    scheme, separator, supplied = (authorization or "").partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not hmac.compare_digest(supplied.strip(), expected)
    ):
        raise HTTPException(status_code=401, detail="unauthorized")


def _new_downloader(api_key: str) -> Any:
    # Import the exact pinned upstream FinNLP implementation at request time.
    # Keeping this lazy also lets unit tests run without downloading upstream code.
    from finnlp.data_sources.news.finnhub_date_range import Finnhub_Date_Range

    return Finnhub_Date_Range({"token": api_key, "max_retry": 1})


def _as_iso_timestamp(value: Any) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def _normalize_article(record: dict[str, Any]) -> dict[str, Any]:
    headline = str(record.get("headline") or "").strip().replace("\r", " ").replace("\n", " ")
    summary = str(record.get("summary") or "").strip()
    url = str(record.get("url") or "").strip()
    parsed_url = urlsplit(url)
    if parsed_url.scheme not in {"https", "http"} or not parsed_url.netloc:
        url = ""

    return {
        "id": record.get("id"),
        "headline": headline[:500],
        "summary": summary[:5000],
        "source": str(record.get("source") or "Unknown source")[:160],
        "url": url,
        "published_at": _as_iso_timestamp(record.get("datetime")),
    }


def _fetch_articles(
    request: NewsRequest,
    api_key: str,
    downloader_factory: Any = _new_downloader,
) -> list[dict[str, Any]]:
    downloader = downloader_factory(api_key)
    articles: list[dict[str, Any]] = []
    cursor = request.start_date
    # FinNLP's Finnhub downloader uses four-day windows. Calling the same
    # upstream client in bounded windows avoids its empty-dataframe edge case
    # while preserving the provider's actual response (including an empty list).
    while cursor <= request.end_date:
        chunk_end = min(cursor + timedelta(days=3), request.end_date)
        records = downloader.finnhub_client.company_news(
            request.ticker,
            _from=cursor.isoformat(),
            to=chunk_end.isoformat(),
        )
        if not isinstance(records, list):
            raise RuntimeError("unexpected_provider_response")
        articles.extend(_normalize_article(record) for record in records if isinstance(record, dict))
        cursor = chunk_end + timedelta(days=1)

    unique: dict[str, dict[str, Any]] = {}
    for article in articles:
        stable_key = str(article.get("id") or "") or "|".join(
            (article["published_at"] or "", article["headline"], article["url"])
        )
        unique[stable_key] = article
    return sorted(
        unique.values(),
        key=lambda article: article["published_at"] or "",
        reverse=True,
    )


def _safe_markdown(request: NewsRequest, articles: list[dict[str, Any]]) -> str:
    lines = [
        f"# FinNLP news evidence: {request.ticker}",
        "",
        f"- **Date range:** {request.start_date.isoformat()} to {request.end_date.isoformat()} (inclusive)",
        "- **Provider:** FinNLP / Finnhub company news",
        f"- **Articles returned:** {len(articles)}",
        "",
    ]
    if not articles:
        lines.extend([
            "No articles were returned by the provider for this date range.",
            "",
            "No synthetic or placeholder headlines have been substituted.",
        ])
    else:
        lines.append("## News")
        lines.append("")
        for index, article in enumerate(articles, start=1):
            headline = article["headline"] or "Untitled article"
            lines.append(f"### {index}. {headline}")
            lines.append("")
            lines.append(f"- **Source:** {article['source']}")
            if article["published_at"]:
                lines.append(f"- **Published:** {article['published_at']}")
            if article["url"]:
                lines.append(f"- **URL:** {article['url']}")
            if article["summary"]:
                lines.append("")
                for summary_line in article["summary"].splitlines():
                    lines.append(f"> {summary_line}")
            lines.append("")
    lines.extend([
        "---",
        "This is source-retrieved news evidence, not an investment recommendation or a trading decision.",
    ])
    return "\n".join(lines)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "provider_configured": bool(os.getenv("FINNHUB_API_KEY", "").strip()),
        "bridge_auth_configured": bool(os.getenv("FINNLP_BRIDGE_API_KEY", "").strip()),
    }


@app.post("/execute/news")
async def execute_news(
    payload: NewsRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_bridge_key(authorization)
    api_key = os.getenv("FINNHUB_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="finnhub_api_key_not_configured")

    try:
        articles = await run_in_threadpool(_fetch_articles, payload, api_key)
    except Exception as error:
        # Never return/log provider exception text: SDK errors can contain request data.
        logger.warning("FinNLP provider request failed (%s)", type(error).__name__)
        raise HTTPException(status_code=502, detail="news_provider_request_failed") from None

    fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "ticker": payload.ticker,
        "start_date": payload.start_date.isoformat(),
        "end_date": payload.end_date.isoformat(),
        "provider": "FinNLP/Finnhub",
        "fetched_at": fetched_at,
        "article_count": len(articles),
        "articles": articles,
        "summary_markdown": _safe_markdown(payload, articles),
    }

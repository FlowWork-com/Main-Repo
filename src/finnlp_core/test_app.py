from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as bridge


class FakeFinnhubClient:
    def __init__(self, records=None, error=None):
        self.records = records or []
        self.error = error
        self.calls = []

    def company_news(self, ticker, *, _from, to):
        self.calls.append((ticker, _from, to))
        if self.error is not None:
            raise self.error
        return self.records


class FakeDownloader:
    def __init__(self, api_key, records=None, error=None):
        self.api_key = api_key
        self.finnhub_client = FakeFinnhubClient(records=records, error=error)


class FinNLPBridgeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(bridge.app)
        self.env = patch.dict(
            os.environ,
            {
                "FINNHUB_API_KEY": "test-provider-key",
                "FINNLP_BRIDGE_API_KEY": "test-bridge-key",
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_health_is_available_without_exposing_secrets(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "status": "ok",
            "provider_configured": True,
            "bridge_auth_configured": True,
        })
        self.assertNotIn("test-provider-key", response.text)
        self.assertNotIn("test-bridge-key", response.text)

    def test_requires_bridge_bearer_token(self):
        with patch.object(bridge, "_new_downloader") as factory:
            response = self.client.post(
                "/execute/news",
                json={"ticker": "AAPL", "start_date": "2026-10-01", "end_date": "2026-10-03"},
            )
        self.assertEqual(response.status_code, 401)
        factory.assert_not_called()

    def test_returns_real_provider_rows_as_structured_and_markdown_data(self):
        records = [
            {
                "id": 7,
                "headline": "A real provider headline",
                "summary": "A provider supplied summary.",
                "source": "Reuters",
                "url": "https://example.com/news/7",
                "datetime": 1790812800,
            }
        ]
        fake = FakeDownloader("test-provider-key", records=records)
        with patch.object(bridge, "_new_downloader", return_value=fake):
            response = self.client.post(
                "/execute/news",
                headers={"Authorization": "Bearer test-bridge-key"},
                json={"ticker": "aapl", "start_date": "2026-10-01", "end_date": "2026-10-03"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["ticker"], "AAPL")
        self.assertEqual(payload["article_count"], 1)
        self.assertEqual(payload["articles"][0]["headline"], "A real provider headline")
        self.assertIn("A real provider headline", payload["summary_markdown"])
        self.assertIn("https://example.com/news/7", payload["summary_markdown"])
        self.assertNotIn("Shares Surge on Institutional Volume Growth", payload["summary_markdown"])

    def test_empty_provider_result_is_empty_not_mock_data(self):
        fake = FakeDownloader("test-provider-key", records=[])
        with patch.object(bridge, "_new_downloader", return_value=fake):
            response = self.client.post(
                "/execute/news",
                headers={"Authorization": "Bearer test-bridge-key"},
                json={"ticker": "AAPL", "start_date": "2026-10-01", "end_date": "2026-10-03"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["article_count"], 0)
        self.assertEqual(payload["articles"], [])
        self.assertIn("No synthetic or placeholder headlines", payload["summary_markdown"])

    def test_rejects_invalid_symbols_and_oversized_ranges(self):
        with patch.object(bridge, "_new_downloader") as factory:
            invalid_ticker = self.client.post(
                "/execute/news",
                headers={"Authorization": "Bearer test-bridge-key"},
                json={"ticker": "AAPL;DROP", "start_date": "2026-10-01", "end_date": "2026-10-03"},
            )
            too_wide = self.client.post(
                "/execute/news",
                headers={"Authorization": "Bearer test-bridge-key"},
                json={"ticker": "AAPL", "start_date": "2026-09-01", "end_date": "2026-10-26"},
            )
        self.assertEqual(invalid_ticker.status_code, 422)
        self.assertEqual(too_wide.status_code, 422)
        factory.assert_not_called()

    def test_chunks_longer_valid_range_without_overlapping_dates(self):
        fake = FakeDownloader("test-provider-key", records=[])
        with patch.object(bridge, "_new_downloader", return_value=fake):
            response = self.client.post(
                "/execute/news",
                headers={"Authorization": "Bearer test-bridge-key"},
                json={"ticker": "MSFT", "start_date": "2026-10-01", "end_date": "2026-10-08"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(fake.finnhub_client.calls, [
            ("MSFT", "2026-10-01", "2026-10-04"),
            ("MSFT", "2026-10-05", "2026-10-08"),
        ])

    def test_provider_errors_are_sanitized(self):
        fake = FakeDownloader("test-provider-key", error=RuntimeError("token=test-provider-key"))
        with patch.object(bridge, "_new_downloader", return_value=fake):
            response = self.client.post(
                "/execute/news",
                headers={"Authorization": "Bearer test-bridge-key"},
                json={"ticker": "AAPL", "start_date": "2026-10-01", "end_date": "2026-10-03"},
            )
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "news_provider_request_failed")
        self.assertNotIn("test-provider-key", response.text)


if __name__ == "__main__":
    unittest.main()

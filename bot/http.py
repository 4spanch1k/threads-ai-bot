from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class ApiError(RuntimeError):
    """Raised when an external HTTP API returns an error."""


class JsonHttpClient:
    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self.timeout_seconds = timeout_seconds

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        query: Mapping[str, str | int | bool] | None = None,
        json_body: Mapping[str, Any] | list[Any] | None = None,
        expected_statuses: tuple[int, ...] = (200, 201, 204),
    ) -> Any:
        if query:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{urlencode(query)}"

        request_headers = {
            "Accept": "application/json",
            "User-Agent": "threads-lead-bot/0.1",
            **(headers or {}),
        }
        data: bytes | None = None
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        elif method.upper() in {"POST", "PUT", "PATCH"}:
            data = b""

        request = Request(url, data=data, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                status = response.status
                body = response.read()
        except HTTPError as error:
            error_body = error.read(2_000).decode("utf-8", errors="replace")
            raise ApiError(f"{method.upper()} {url} failed ({error.code}): {error_body}") from error
        except URLError as error:
            raise ApiError(f"{method.upper()} {url} failed: {error.reason}") from error

        if status not in expected_statuses:
            body_text = body[:2_000].decode("utf-8", errors="replace")
            raise ApiError(f"{method.upper()} {url} returned {status}: {body_text}")

        if not body:
            return None
        try:
            return json.loads(body)
        except json.JSONDecodeError as error:
            raise ApiError(f"{method.upper()} {url} returned invalid JSON") from error

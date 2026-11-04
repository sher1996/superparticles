"""Tiny HTTP layer shared by all API clients.

`Transport` is the seam between the engine and the outside world: live mode
uses `RequestsTransport` (real HTTPS calls to the official APIs), demo mode uses
`app.mock.transport.MockTransport`, which answers with the same JSON shapes the
real APIs return. The client code (and its parsing) is identical in both modes.
"""
from __future__ import annotations

import json as _json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import requests


class EngineError(Exception):
    """An error with a plain-language message and a hint on how to fix it."""

    def __init__(self, source: str, message: str, hint: str = "", status: int | None = None):
        super().__init__(message)
        self.source = source
        self.message = message
        self.hint = hint
        self.status = status

    def user_text(self) -> str:
        text = f"[{self.source}] {self.message}"
        if self.hint:
            text += f" -> {self.hint}"
        return text


class CredentialError(EngineError):
    """Login rejected / missing permission. Retrying will not help."""


class RateLimitError(EngineError):
    """API limit reached and the wait would be too long."""

    def __init__(self, source: str, message: str, hint: str = "", retry_after: float | None = None):
        super().__init__(source, message, hint, status=429)
        self.retry_after = retry_after


class ApiError(EngineError):
    """Any other API failure (bad request, server error, unreachable)."""


@dataclass
class Response:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    text: str = ""

    def json(self) -> Any:
        if not self.text:
            return {}
        return _json.loads(self.text)

    def header(self, name: str) -> str | None:
        lname = name.lower()
        for k, v in self.headers.items():
            if k.lower() == lname:
                return v
        return None


class Transport:
    is_mock = False

    def send(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        json: Any = None,
        data: dict[str, Any] | None = None,
        basic_auth: tuple[str, str] | None = None,
        timeout: float = 30,
    ) -> Response:
        raise NotImplementedError


class RequestsTransport(Transport):
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "bol-opportunity-engine/1.0"

    def send(self, method, url, *, params=None, headers=None, json=None, data=None,
             basic_auth=None, timeout=30) -> Response:
        hdrs = dict(headers or {})
        body = None
        if json is not None:
            body = _json.dumps(json)
            hdrs.setdefault("Content-Type", "application/json")
        r = self.session.request(
            method, url, params=params, headers=hdrs, data=body if body is not None else data,
            auth=basic_auth, timeout=timeout,
        )
        return Response(status=r.status_code, headers=dict(r.headers), text=r.text)


def request_with_retry(
    transport: Transport,
    source: str,
    method: str,
    url: str,
    *,
    max_retries: int = 4,
    max_wait: float = 90.0,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str, str], None] | None = None,
    **kwargs: Any,
) -> Response:
    """Send a request; wait and retry on 429 (honouring Retry-After), 5xx and
    network errors. Raises a clear EngineError when it gives up."""
    attempt = 0
    while True:
        try:
            resp = transport.send(method, url, **kwargs)
        except requests.RequestException as exc:
            if attempt >= max_retries:
                raise ApiError(source, f"Could not reach the API ({exc.__class__.__name__}).",
                               "Check your internet connection or try again later.") from exc
            wait = min(2 ** attempt, 30)
            if log:
                log("warning", f"{source}: network error, retrying in {wait:.0f}s")
            sleep(0 if transport.is_mock else wait)
            attempt += 1
            continue

        if resp.status == 429:
            retry_after = _parse_retry_after(resp.header("Retry-After"))
            wait = retry_after if retry_after is not None else min(2 ** (attempt + 1), 60)
            if attempt >= max_retries or wait > max_wait:
                raise RateLimitError(
                    source,
                    f"API rate limit reached (HTTP 429, retry after {wait:.0f}s).",
                    "The engine will continue with what it has; lower 'Max keywords per run' "
                    "in Settings if this happens every day.",
                    retry_after=wait,
                )
            if log:
                log("warning", f"{source}: rate limited, waiting {wait:.0f}s (attempt {attempt + 1})")
            sleep(0 if transport.is_mock else wait)
            attempt += 1
            continue

        if resp.status >= 500:
            if attempt >= max_retries:
                raise ApiError(source, f"The API had a server error (HTTP {resp.status}).",
                               "Usually temporary; the next run will try again.", status=resp.status)
            wait = min(2 ** attempt, 30)
            if log:
                log("warning", f"{source}: HTTP {resp.status}, retrying in {wait:.0f}s")
            sleep(0 if transport.is_mock else wait)
            attempt += 1
            continue

        return resp


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def raise_for_status(resp: Response, source: str, what: str) -> None:
    """Turn 4xx responses into clear errors."""
    if resp.status < 400:
        return
    detail = ""
    try:
        body = resp.json()
        if isinstance(body, dict):
            detail = str(body.get("detail") or body.get("title") or body.get("message")
                         or body.get("error_description") or body.get("error") or "")
    except ValueError:
        detail = resp.text[:200]
    if resp.status == 401:
        raise CredentialError(source, f"Not authorised while {what} (HTTP 401). {detail}".strip(),
                              "Check the client id/secret in your .env file.", status=401)
    if resp.status == 403:
        raise CredentialError(source, f"Access denied while {what} (HTTP 403). {detail}".strip(),
                              "Your account may not have access to this API yet "
                              "(e.g. Insights needs an active seller account).", status=403)
    raise ApiError(source, f"Request failed while {what} (HTTP {resp.status}). {detail}".strip(),
                   status=resp.status)

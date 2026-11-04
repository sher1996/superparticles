"""Official bol APIs: Retailer API v10 (seller account) and Marketing Catalog API
(affiliate account). Both authenticate with OAuth2 client credentials at
login.bol.com. No scraping: every request goes to a documented endpoint.

Docs: https://api.bol.com/retailer/public/Retailer-API/ and
https://api.bol.com/marketing/docs/catalog-api/
"""
from __future__ import annotations

import time
from datetime import date
from typing import Any, Callable

from .http import (ApiError, CredentialError, Transport, raise_for_status,
                   request_with_retry)

LOGIN_URL = "https://login.bol.com/token"
RETAILER_LIVE = "https://api.bol.com/retailer"
RETAILER_DEMO = "https://api.bol.com/retailer-demo"
CATALOG_BASE = "https://api.bol.com/marketing/catalog/v1"
RETAILER_ACCEPT = "application/vnd.retailer.v10+json"


class BolTokenProvider:
    """Caches the access token (valid ~5 minutes) and renews it when needed."""

    def __init__(self, transport: Transport, client_id: str, client_secret: str, source: str,
                 log: Callable[[str, str], None] | None = None):
        self.transport = transport
        self.client_id = client_id
        self.client_secret = client_secret
        self.source = source
        self.log = log
        self._token: str | None = None
        self._expires_at = 0.0

    def token(self) -> str:
        if self._token and time.time() < self._expires_at - 30:
            return self._token
        if not (self.client_id and self.client_secret):
            raise CredentialError(self.source, "No client id/secret configured.",
                                  "Add them to your .env file (see README).")
        resp = request_with_retry(
            self.transport, self.source, "POST", LOGIN_URL,
            params={"grant_type": "client_credentials"},
            headers={"Accept": "application/json"},
            basic_auth=(self.client_id, self.client_secret),
            log=self.log,
        )
        if resp.status in (400, 401, 403):
            raise CredentialError(
                self.source,
                f"bol login rejected the client id/secret (HTTP {resp.status}).",
                "Copy the credentials again from your bol account (API settings) into .env. "
                "Seller credentials go in BOL_CLIENT_ID/SECRET, affiliate credentials in "
                "BOL_AFFILIATE_CLIENT_ID/SECRET.",
                status=resp.status,
            )
        raise_for_status(resp, self.source, "logging in")
        body = resp.json()
        self._token = body.get("access_token")
        if not self._token:
            raise CredentialError(self.source, "bol login returned no access token.")
        self._expires_at = time.time() + float(body.get("expires_in", 299))
        return self._token

    def invalidate(self) -> None:
        self._token = None


class BolRetailerClient:
    source = "bol Retailer API"

    def __init__(self, transport: Transport, client_id: str, client_secret: str,
                 base_url: str = RETAILER_LIVE, log: Callable[[str, str], None] | None = None):
        self.transport = transport
        self.base = base_url.rstrip("/")
        self.log = log
        self.auth = BolTokenProvider(transport, client_id, client_secret, self.source, log)

    # -- plumbing -----------------------------------------------------------
    def _call(self, method: str, path: str, what: str, *, params=None, json=None,
              allow_404: bool = False) -> Any:
        for attempt in range(2):
            headers = {
                "Authorization": f"Bearer {self.auth.token()}",
                "Accept": RETAILER_ACCEPT,
                "Accept-Language": "nl",
            }
            if json is not None:
                headers["Content-Type"] = RETAILER_ACCEPT
            resp = request_with_retry(self.transport, self.source, method, self.base + path,
                                      params=params, headers=headers, json=json, log=self.log)
            if resp.status == 401 and attempt == 0:
                self.auth.invalidate()  # token expired early: log in again once
                continue
            if allow_404 and resp.status == 404:
                return None
            raise_for_status(resp, self.source, what)
            return resp.json()
        return None

    # -- endpoints ------------------------------------------------------------
    def search_terms(self, term: str, periods: int = 156, period: str = "WEEK",
                     related: bool = True) -> dict[str, Any]:
        """GET /insights/search-terms: search volume per period + related terms."""
        body = self._call("GET", "/insights/search-terms", f"getting search volume for '{term}'",
                          params={"search-term": term, "period": period,
                                  "number-of-periods": periods,
                                  "related-search-terms": str(related).lower()},
                          allow_404=True) or {}
        st = body.get("searchTerms") or {}
        if isinstance(st, list):
            st = st[0] if st else {}
        weeks: list[tuple[int, int, int]] = []
        for p in st.get("periods") or []:
            per = p.get("period") or {}
            year = per.get("year")
            num = per.get("week") if period == "WEEK" else per.get("month")
            if year is None or num is None:
                continue
            weeks.append((int(year), int(num), int(p.get("total") or 0)))
        related_terms = [
            (str(r.get("searchTerm")), int(r.get("total") or 0))
            for r in (st.get("relatedSearchTerms") or [])
            if r.get("searchTerm")
        ]
        return {"term": st.get("searchTerm", term), "total": int(st.get("total") or 0),
                "periods": sorted(weeks), "related": related_terms}

    def product_list(self, search_term: str, sort: str = "RELEVANCE", page: int = 1,
                     country: str = "NL") -> list[dict[str, Any]]:
        """POST /products/list: products for a search term in bol's ranked order."""
        body = self._call("POST", "/products/list", f"listing products for '{search_term}'",
                          json={"countryCode": country, "searchTerm": search_term,
                                "sort": sort, "page": page}, allow_404=True) or {}
        out = []
        for p in body.get("products") or []:
            eans = [e.get("ean") for e in (p.get("eans") or []) if e.get("ean")]
            if eans:
                out.append({"ean": eans[0], "title": p.get("title") or ""})
        return out

    def product_ranks(self, ean: str, on_date: date, rank_type: str = "SEARCH") -> list[dict[str, Any]]:
        """GET /insights/product-ranks: rank + impressions per search term (last ~3 months)."""
        body = self._call("GET", "/insights/product-ranks", f"getting ranks for EAN {ean}",
                          params={"ean": ean, "date": on_date.isoformat(), "type": rank_type,
                                  "page": 1}, allow_404=True) or {}
        return [
            {"search_term": r.get("searchTerm") or "", "rank": r.get("rank"),
             "impressions": r.get("impressions"), "sponsored": bool(r.get("sponsored"))}
            for r in (body.get("ranks") or [])
        ]

    def competing_offers(self, ean: str, country: str = "NL") -> list[dict[str, Any]]:
        """GET /products/{ean}/offers: every seller offering this EAN."""
        body = self._call("GET", f"/products/{ean}/offers", f"getting offers for EAN {ean}",
                          params={"country-code": country, "best-offer-only": "false",
                                  "condition": "NEW", "page": 1}, allow_404=True) or {}
        return [
            {"retailer_id": o.get("retailerId"), "price": _f(o.get("price")),
             "fulfilment": o.get("fulfilmentMethod"), "best": bool(o.get("bestOffer"))}
            for o in (body.get("offers") or [])
        ]

    def ratings(self, ean: str) -> dict[str, Any]:
        """GET /products/{ean}/ratings: number of reviews per star."""
        body = self._call("GET", f"/products/{ean}/ratings", f"getting ratings for EAN {ean}",
                          allow_404=True) or {}
        count = 0
        total = 0.0
        for r in body.get("ratings") or []:
            c = int(r.get("count") or 0)
            count += c
            total += c * float(r.get("rating") or 0)
        return {"count": count, "average": round(total / count, 2) if count else None}

    def check_connection(self) -> str:
        """Log in and make one cheap call (used by the Settings page)."""
        self.auth.token()
        self._call("GET", "/orders", "checking the connection", params={"page": 1})
        return "Connected"


class BolCatalogClient:
    """Marketing Catalog API (affiliate): public product data, price, delivery."""

    source = "bol Marketing Catalog API"

    def __init__(self, transport: Transport, client_id: str, client_secret: str,
                 log: Callable[[str, str], None] | None = None):
        self.transport = transport
        self.log = log
        self.auth = BolTokenProvider(transport, client_id, client_secret, self.source, log)

    def product(self, ean: str, country: str = "NL") -> dict[str, Any] | None:
        for attempt in range(2):
            resp = request_with_retry(
                self.transport, self.source, "GET", f"{CATALOG_BASE}/products/{ean}",
                params={"country-code": country, "include-offer": "true",
                        "include-image": "true", "include-rating": "true",
                        "include-specifications": "false"},
                headers={"Authorization": f"Bearer {self.auth.token()}",
                         "Accept": "application/json", "Accept-Language": "nl"},
                log=self.log,
            )
            if resp.status == 401 and attempt == 0:
                self.auth.invalidate()
                continue
            if resp.status == 404:
                return None
            raise_for_status(resp, self.source, f"getting catalog data for EAN {ean}")
            b = resp.json()
            offer = b.get("offer") or {}
            image = b.get("image") or {}
            rating = b.get("rating")
            if isinstance(rating, dict):
                rating = rating.get("average")
            return {
                "ean": b.get("ean", ean),
                "title": b.get("title") or "",
                "description": b.get("description") or "",
                "url": b.get("url") or offer.get("url") or "",
                "image_url": image.get("url") or "",
                "rating": _f(rating),
                "price": _f(offer.get("price")),
                "strikethrough_price": _f(offer.get("strikethroughPrice")),
                "delivery": offer.get("deliveryDescription") or "",
            }
        return None

    def check_connection(self) -> str:
        self.auth.token()
        return "Connected"


def _f(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


__all__ = ["BolRetailerClient", "BolCatalogClient", "BolTokenProvider", "ApiError",
           "RETAILER_LIVE", "RETAILER_DEMO"]

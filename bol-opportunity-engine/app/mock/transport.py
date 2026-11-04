"""MockTransport: answers HTTP requests for the bol Retailer API, the bol
Marketing Catalog API and the AliExpress Affiliate API with the same JSON shapes
the real APIs use, generated from the DemoWorld. It also checks what a real
API would check (Bearer token present, AliExpress signature valid)."""
from __future__ import annotations

import json
import re
from datetime import date
from urllib.parse import urlparse

from ..clients.aliexpress import sign
from ..clients.http import Response, Transport
from .world import DemoWorld, unit

DEMO_ALI_KEY = "demo-app-key"
DEMO_ALI_SECRET = "demo-app-secret"
DEMO_BOL_ID = "demo-client-id"
DEMO_BOL_SECRET = "demo-client-secret"


def _json(status: int, body: object, headers: dict | None = None) -> Response:
    return Response(status=status, headers={"Content-Type": "application/json", **(headers or {})},
                    text=json.dumps(body))


class MockTransport(Transport):
    is_mock = True

    def __init__(self, world: DemoWorld, simulate_errors: bool = False, ali_secret: str = DEMO_ALI_SECRET):
        self.world = world
        self.simulate_errors = simulate_errors
        self.ali_secret = ali_secret
        self.calls = 0
        self.requests: list[tuple[str, str]] = []

    def send(self, method, url, *, params=None, headers=None, json=None, data=None,
             basic_auth=None, timeout=30) -> Response:
        self.calls += 1
        self.requests.append((method, url))
        params = dict(params or {})
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        if self.simulate_errors and self.calls % 17 == 0:
            return _json(429, {"title": "Too Many Requests", "status": 429}, {"Retry-After": "1"})
        u = urlparse(url)
        path = u.path

        if u.netloc == "login.bol.com":
            if not basic_auth or not basic_auth[0] or not basic_auth[1]:
                return _json(401, {"error": "invalid_client"})
            return _json(200, {"access_token": f"demo-token-{self.calls}", "token_type": "Bearer",
                               "expires_in": 299, "scope": "RETAILER"})

        if u.netloc == "api-sg.aliexpress.com":
            return self._ali(dict(data or {}))

        if not headers.get("authorization", "").startswith("Bearer "):
            return _json(401, {"title": "Unauthorized", "status": 401})

        w = self.world
        if path.startswith("/marketing/catalog/v1/products/"):
            ean = path.rsplit("/", 1)[-1]
            c, i = w.parse_ean(ean)
            if c is None:
                return _json(404, {"title": "Not Found", "status": 404})
            price = w.price(c, i)
            return _json(200, {
                "ean": ean,
                "bolProductId": f"93000{ean[-8:]}",
                "title": w.bol_title(c, i),
                "description": (c.nl + " ") * (3 if i < 6 else 1),
                "url": f"https://www.bol.com/nl/nl/s/?searchtext={c.nl.replace(' ', '+')}",
                "image": {"url": f"/demo-img/bol/{ean}.svg", "width": 400, "height": 400},
                "rating": round(3.6 + unit("rt", ean) * 1.3, 1) if w.reviews(c, i) else None,
                "offer": {"price": price,
                          "strikethroughPrice": round(price * 1.2, 2) if i % 3 == 0 else None,
                          "deliveryDescription": "Morgen in huis" if i % 2 == 0 else "1-2 werkdagen",
                          "url": f"https://www.bol.com/nl/nl/s/?searchtext={c.nl.replace(' ', '+')}"},
            })

        m = re.match(r"^/retailer(?:-demo)?(/.*)$", path)
        if not m:
            return _json(404, {"title": "Not Found", "status": 404})
        rpath = m.group(1)

        if rpath == "/insights/search-terms":
            term = str(params.get("search-term") or "")
            periods = min(208, int(params.get("number-of-periods") or 52))
            return _json(200, w.search_terms(term, periods))

        if rpath == "/products/list" and method == "POST":
            term = (json or {}).get("searchTerm", "")
            return _json(200, {"products": [{"title": p["title"], "eans": [{"ean": p["ean"]}]}
                                            for p in w.products_for(term)],
                               "sort": (json or {}).get("sort", "RELEVANCE")})

        if rpath == "/insights/product-ranks":
            on = date.fromisoformat(str(params.get("date")))
            return _json(200, {"ranks": w.ranks(str(params.get("ean")), on)})

        m2 = re.match(r"^/products/(\d{13})/(offers|ratings)$", rpath)
        if m2:
            ean, what = m2.groups()
            c, i = w.parse_ean(ean)
            if c is None:
                return _json(404, {"title": "Not Found", "status": 404})
            if what == "offers":
                n = w.offers_count(c, i)
                base = w.price(c, i)
                offers = [{"offerId": f"{ean}-{k}", "retailerId": 1000 + k, "countryCode": "NL",
                           "bestOffer": k == 0, "price": round(base * (1 + 0.04 * k), 2),
                           "fulfilmentMethod": "FBB" if k % 2 == 0 else "FBR", "condition": "NEW"}
                          for k in range(n)]
                return _json(200, {"offers": offers})
            total = w.reviews(c, i)
            split = [0.04, 0.04, 0.10, 0.27, 0.55]
            return _json(200, {"ratings": [{"rating": s + 1, "count": int(round(total * split[s]))}
                                           for s in range(5)]})

        if rpath == "/orders":
            return _json(200, {"orders": []})

        return _json(404, {"title": "Not Found", "status": 404, "detail": f"No demo data for {rpath}"})

    def _ali(self, params: dict) -> Response:
        given = params.pop("sign", "")
        if not params.get("app_key"):
            return _json(200, {"error_response": {"code": "InvalidAppKey", "msg": "App key is missing"}})
        if sign(params, self.ali_secret) != given:
            return _json(200, {"error_response": {"code": "IncompleteSignature",
                                                  "msg": "The request signature does not conform to platform standards"}})
        method = params.get("method", "")
        page = int(params.get("page_no") or 1)
        size = int(params.get("page_size") or 20)
        if method == "aliexpress.affiliate.hotproduct.query":
            products = self.world.ali_hot(page, size)
        elif method == "aliexpress.affiliate.product.query":
            products = self.world.ali_search(str(params.get("keywords") or ""), size)
        else:
            return _json(200, {"error_response": {"code": "InvalidApiPath", "msg": f"Unknown method {method}"}})
        key = method.replace(".", "_") + "_response"
        if not products:
            return _json(200, {key: {"resp_result": {"resp_code": 405, "resp_msg": "No results"}}})
        return _json(200, {key: {"resp_result": {"resp_code": 200, "resp_msg": "Call succeeds", "result": {
            "current_page_no": page, "current_record_count": len(products),
            "total_record_count": len(products) + (page - 1) * size,
            "products": {"product": products}}}}})

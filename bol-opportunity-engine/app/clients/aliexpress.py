"""AliExpress Affiliate (Open Platform) API: hotproduct.query and product.query.

Requests are signed with HMAC-SHA256 as the AliExpress Open Platform documents:
sort all parameters by name, concatenate name+value, HMAC with the app secret,
hex upper-case. Docs: https://openservice.aliexpress.com/doc/api.htm
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any, Callable

from .http import ApiError, CredentialError, RateLimitError, Transport, request_with_retry

GATEWAY = "https://api-sg.aliexpress.com/sync"

FIELDS = ",".join([
    "product_id", "product_title", "product_main_image_url", "product_small_image_urls",
    "product_detail_url", "promotion_link", "target_sale_price", "target_sale_price_currency",
    "target_original_price", "lastest_volume", "evaluate_rate", "first_level_category_id",
    "first_level_category_name", "second_level_category_id", "second_level_category_name",
    "shop_id", "ship_to_days",
])

CREDENTIAL_CODES = {"IncompleteSignature", "InvalidAppKey", "InvalidApiPath", "AppKeyNotExist",
                    "InsufficientPermission", "Isv.InvalidAppKey", "InvalidSignature",
                    "IllegalAccessToken", "AppNotExist"}
LIMIT_CODES = {"ApiCallLimit", "AppCallLimit", "FrequencyLimit", "isv.ApiCallLimit"}


def sign(params: dict[str, Any], secret: str) -> str:
    message = "".join(f"{k}{params[k]}" for k in sorted(params))
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest().upper()


class AliExpressClient:
    source = "AliExpress Affiliate API"

    def __init__(self, transport: Transport, app_key: str, app_secret: str, tracking_id: str = "",
                 log: Callable[[str, str], None] | None = None,
                 currency: str = "EUR", language: str = "EN", ship_to: str = "NL"):
        self.transport = transport
        self.app_key = app_key
        self.app_secret = app_secret
        self.tracking_id = tracking_id
        self.log = log
        self.currency = currency
        self.language = language
        self.ship_to = ship_to

    def _call(self, method: str, business: dict[str, Any], what: str) -> dict[str, Any]:
        if not (self.app_key and self.app_secret):
            raise CredentialError(self.source, "No app key/secret configured.",
                                  "Add ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET to .env.")
        params: dict[str, Any] = {
            "app_key": self.app_key,
            "method": method,
            "sign_method": "sha256",
            "timestamp": str(int(time.time() * 1000)),
            "format": "json",
            "v": "2.0",
        }
        params.update({k: v for k, v in business.items() if v not in (None, "")})
        params["sign"] = sign(params, self.app_secret)
        resp = request_with_retry(self.transport, self.source, "POST", GATEWAY, data=params,
                                  headers={"Content-Type": "application/x-www-form-urlencoded;charset=utf-8"},
                                  log=self.log)
        try:
            body = resp.json()
        except ValueError as exc:
            raise ApiError(self.source, f"Unexpected answer while {what} (HTTP {resp.status}).") from exc
        err = body.get("error_response")
        if err:
            code = str(err.get("code") or "")
            msg = str(err.get("msg") or err.get("sub_msg") or code)
            if code in CREDENTIAL_CODES or "sign" in code.lower() or "appkey" in code.lower():
                raise CredentialError(self.source, f"AliExpress rejected the request: {msg} ({code}).",
                                      "Check ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET and that your "
                                      "app has the Affiliate API permission.")
            if code in LIMIT_CODES or "limit" in code.lower():
                raise RateLimitError(self.source, f"AliExpress API limit reached: {msg}.",
                                     "Try again later or request a higher limit in the AliExpress "
                                     "Open Platform console.")
            raise ApiError(self.source, f"AliExpress error while {what}: {msg} ({code}).")
        if resp.status >= 400:
            raise ApiError(self.source, f"HTTP {resp.status} while {what}.", status=resp.status)
        key = method.replace(".", "_") + "_response"
        result = ((body.get(key) or {}).get("resp_result") or {})
        code = result.get("resp_code")
        if code not in (None, 200, "200"):
            # 405 = no results for these filters: not an error for us
            if str(code) == "405":
                return {"products": []}
            raise ApiError(self.source, f"AliExpress returned {code}: {result.get('resp_msg')}")
        res = result.get("result") or {}
        products = ((res.get("products") or {}).get("product")) or []
        return {"products": [parse_product(p) for p in products],
                "total": int(res.get("total_record_count") or 0)}

    def hot_products(self, category_ids: str = "", keywords: str = "", page_no: int = 1,
                     page_size: int = 50) -> list[dict[str, Any]]:
        return self._call("aliexpress.affiliate.hotproduct.query", {
            "category_ids": category_ids, "keywords": keywords, "page_no": page_no,
            "page_size": page_size, "sort": "LAST_VOLUME_DESC", "target_currency": self.currency,
            "target_language": self.language, "ship_to_country": self.ship_to,
            "tracking_id": self.tracking_id, "fields": FIELDS, "platform_product_type": "ALL",
        }, "getting hot products")["products"]

    def search_products(self, keywords: str, page_size: int = 20) -> list[dict[str, Any]]:
        return self._call("aliexpress.affiliate.product.query", {
            "keywords": keywords, "page_no": 1, "page_size": page_size,
            "sort": "LAST_VOLUME_DESC", "target_currency": self.currency,
            "target_language": self.language, "ship_to_country": self.ship_to,
            "tracking_id": self.tracking_id, "fields": FIELDS, "platform_product_type": "ALL",
        }, f"searching products for '{keywords}'")["products"]

    def check_connection(self) -> str:
        self.hot_products(page_size=1)
        return "Connected"


def parse_product(p: dict[str, Any]) -> dict[str, Any]:
    rate = str(p.get("evaluate_rate") or "").replace("%", "").strip()
    try:
        rating = round(float(rate) / 20.0, 2) if rate else None  # 96% positive -> 4.8 / 5
    except ValueError:
        rating = None
    images = (p.get("product_small_image_urls") or {}).get("string") or []
    shipping = p.get("shipping_fee") or p.get("estimated_shipping_fee")
    return {
        "product_id": str(p.get("product_id")),
        "title": p.get("product_title") or "",
        "image_url": p.get("product_main_image_url") or "",
        "images": images,
        "url": p.get("promotion_link") or p.get("product_detail_url") or "",
        "detail_url": p.get("product_detail_url") or "",
        "price": _f(p.get("target_sale_price")),
        "original_price": _f(p.get("target_original_price")),
        "currency": p.get("target_sale_price_currency") or "EUR",
        "volume": int(p.get("lastest_volume") or 0),  # sic: the API spells it 'lastest'
        "rating": rating,
        "positive_rate": rate,
        "category": p.get("first_level_category_name") or "",
        "category_id": str(p.get("first_level_category_id") or ""),
        "category2": p.get("second_level_category_name") or "",
        "shipping": _f(shipping),
        "delivery_days": int(p["ship_to_days"]) if str(p.get("ship_to_days") or "").isdigit() else None,
    }


def _f(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None

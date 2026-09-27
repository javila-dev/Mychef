"""PIN opcional de la casa.

Si se define MYCHEF_PIN (p. ej. "2580"), la app pide ese PIN una sola vez por dispositivo
(la tablet de la nevera, los celulares) y lo recuerda un año. Sin MYCHEF_PIN la app queda
abierta, lo cual está bien mientras solo se use dentro de la red de la casa.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

COOKIE = "mychef_auth"
MAX_FAILS = 8
LOCK_SECONDS = 300
_fails: dict[str, list[float]] = {}


def _pin() -> str:
    return os.environ.get("MYCHEF_PIN", "").strip()


def pin_enabled() -> bool:
    return bool(_pin())


def _token() -> str:
    secret = os.environ.get("MYCHEF_SECRET", "mychef") + _pin()
    return hmac.new(secret.encode(), b"household", hashlib.sha256).hexdigest()


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "?"


def check_pin(pin: str, request: Request) -> JSONResponse:
    key = _client_key(request)
    now = time.time()
    recent = [t for t in _fails.get(key, []) if now - t < LOCK_SECONDS]
    if len(recent) >= MAX_FAILS:
        raise HTTPException(429, "Demasiados intentos. Espera 5 minutos.")
    if not pin_enabled() or hmac.compare_digest(pin.strip(), _pin()):
        _fails.pop(key, None)
        resp = JSONResponse({"ok": True})
        if pin_enabled():
            resp.set_cookie(
                COOKIE, _token(), max_age=365 * 24 * 3600, httponly=True, samesite="lax",
                secure=request.url.scheme == "https",
            )
        return resp
    _fails[key] = recent + [now]
    raise HTTPException(401, "PIN incorrecto")


class AuthMiddleware(BaseHTTPMiddleware):
    OPEN = {"/api/auth", "/api/login"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if (
            pin_enabled()
            and path.startswith("/api/")
            and path not in self.OPEN
            and not hmac.compare_digest(request.cookies.get(COOKIE, ""), _token())
        ):
            return JSONResponse({"detail": "Falta el PIN de la casa"}, status_code=401)
        return await call_next(request)

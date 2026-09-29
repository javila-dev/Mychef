"""Quién puede entrar a la app.

Dos formas (si no se define ninguna, la app queda abierta: sirve solo dentro de la red de la casa):

- Usuario y contraseña (para la app publicada en internet, p. ej. en un VPS):
      MYCHEF_USER=casa   MYCHEF_PASSWORD=una-clave-larga
- PIN de la casa (más cómodo, pero solo para la red de la casa):
      MYCHEF_PIN=2580

Cada dispositivo entra una sola vez y la sesión no vence: es una cookie firmada que se renueva cada
vez que el aparato usa la app (la tablet lo hace cada minuto), así nunca llega a su fecha límite.
No depende del servidor: reiniciar o actualizar la app no cierra ninguna sesión. Solo la cierran
cambiar la contraseña, el PIN o MYCHEF_SECRET (en todos los aparatos), «Cerrar sesión» en uno, o
borrar los datos del navegador.
Tras 8 intentos fallidos desde el mismo lugar se bloquea 5 minutos.
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
COOKIE_AGE = 400 * 24 * 3600  # lo máximo que guardan los navegadores (Chrome no deja más de 400 días)
MAX_FAILS = 8
LOCK_SECONDS = 300
_fails: dict[str, list[float]] = {}


def _user() -> str:
    return os.environ.get("MYCHEF_USER", "").strip()


def _password() -> str:
    return os.environ.get("MYCHEF_PASSWORD", "")


def _pin() -> str:
    return os.environ.get("MYCHEF_PIN", "").strip()


def mode() -> str | None:
    """«password», «pin» o None (abierta)."""
    if _user() and _password():
        return "password"
    if _pin():
        return "pin"
    return None


def pin_enabled() -> bool:
    """Si la app pide entrar (con PIN o con usuario y contraseña)."""
    return mode() is not None


def _token() -> str:
    credential = f"user:{_user()}:{_password()}" if mode() == "password" else _pin()
    secret = os.environ.get("MYCHEF_SECRET", "mychef") + credential
    return hmac.new(secret.encode(), b"household", hashlib.sha256).hexdigest()


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "?"


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def _https(request: Request) -> bool:
    # Detrás de un proxy (Caddy, Traefik, nginx) la app ve http aunque afuera sea https
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"


def login(request: Request, pin: str = "", user: str = "", password: str = "") -> JSONResponse:
    key = _client_key(request)
    now = time.time()
    recent = [t for t in _fails.get(key, []) if now - t < LOCK_SECONDS]
    if len(recent) >= MAX_FAILS:
        raise HTTPException(429, "Demasiados intentos. Esperen 5 minutos.")
    m = mode()
    if m == "password":
        # Se comparan los dos siempre, para no delatar cuál estaba mal
        ok = _same(user.strip().lower(), _user().lower()) & _same(password, _password())
    else:
        ok = m is None or _same(pin.strip(), _pin())
    if ok:
        _fails.pop(key, None)
        resp = JSONResponse({"ok": True})
        if m:
            _remember(resp, request)
        return resp
    _fails[key] = recent + [now]
    raise HTTPException(401, "Usuario o contraseña incorrectos" if m == "password" else "PIN incorrecto")


def _remember(resp, request: Request) -> None:
    resp.set_cookie(COOKIE, _token(), max_age=COOKIE_AGE, httponly=True, samesite="lax", secure=_https(request))


def check_pin(pin: str, request: Request) -> JSONResponse:
    return login(request, pin=pin)


def logout(request: Request) -> JSONResponse:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, httponly=True, samesite="lax", secure=_https(request))
    return resp


class AuthMiddleware(BaseHTTPMiddleware):
    OPEN = {"/api/auth", "/api/login", "/api/logout"}
    # La documentación de la API también muestra cómo está hecha: con clave, cerrada
    DOCS = {"/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not pin_enabled() or not (path.startswith("/api/") or path in self.DOCS) or path in self.OPEN:
            return await call_next(request)
        if not _same(request.cookies.get(COOKIE, ""), _token()):
            return JSONResponse({"detail": "Hay que entrar primero"}, status_code=401)
        response = await call_next(request)
        _remember(response, request)  # cada uso le da otros 400 días: la sesión nunca vence
        return response

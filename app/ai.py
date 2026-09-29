"""Proveedores de IA de la casa: Gemini (fotos y texto) y, si prefieren, OpenAI para el texto.

Hay tres usos, cada uno con su modelo elegido en Ajustes (se guarda en la base de datos):
- photo: facturas, nevera, alacena y recetas en foto. Siempre Gemini.
- text: frases que la tablet no entendió y la agenda por voz. Tiene que ser rápido.
- menu: ideas del menú del domingo, el cuestionario de «Cómo comemos» y recetas escritas. Mejor calidad.
El proveedor sale del nombre del modelo: «gemini-…» va a Gemini y lo demás («gpt-…») a OpenAI.
Por defecto todo va con Gemini (una sola clave, y tiene capa gratuita); si la casa solo tiene la
clave de OpenAI, el texto sigue con OpenAI como antes.

Las claves van en variables de entorno (GEMINI_API_KEY o GOOGLE_API_KEY, y OPENAI_API_KEY).
Sin clave, el resto de la aplicación funciona igual y solo esas funciones avisan.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import TypeVar

import openai
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import BaseModel, ValidationError

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

MODEL_NAME = re.compile(r"^[\w.\-:/]{2,80}$")
KEY_ENV = {"Gemini": "GEMINI_API_KEY", "OpenAI": "OPENAI_API_KEY"}

# Modelos por defecto de cada uso, según el proveedor (se pueden cambiar con MYCHEF_*_MODEL)
ROLES = {
    "photo": {"setting": "ai_photo_model", "env": "MYCHEF_PHOTO_MODEL",
              "Gemini": "gemini-2.5-flash", "OpenAI": None},
    "text": {"setting": "ai_text_model", "env": "MYCHEF_TEXT_MODEL",
             "Gemini": "gemini-2.5-flash-lite", "OpenAI": "gpt-5-mini"},
    "menu": {"setting": "ai_menu_model", "env": "MYCHEF_MENU_MODEL",
             "Gemini": "gemini-2.5-flash", "OpenAI": "gpt-5-mini"},
}


class AIError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def gemini_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


def openai_key() -> str | None:
    return os.environ.get("OPENAI_API_KEY")


def provider_of(model: str) -> str:
    return "Gemini" if model.removeprefix("models/").startswith(("gemini", "gemma")) else "OpenAI"


def has_key(provider: str) -> bool:
    return bool(gemini_key() if provider == "Gemini" else openai_key())


def default_model(role: str) -> str:
    r = ROLES[role]
    if os.environ.get(r["env"]):
        return os.environ[r["env"]]
    # Gemini si está su clave (o si no hay ninguna: es lo recomendado); OpenAI si es la única que hay
    if r["OpenAI"] and not gemini_key() and openai_key():
        return r["OpenAI"]
    return r["Gemini"]


DEFAULT_PHOTO_MODEL = ROLES["photo"]["Gemini"]


def model_for(session, role: str) -> str:
    """El modelo elegido en Ajustes para ese uso, o el de por defecto."""
    from .models import Setting

    s = session.get(Setting, ROLES[role]["setting"])
    return s.value if s and s.value else default_model(role)


def ready(session, role: str) -> bool:
    """¿Está la clave del proveedor del modelo que usa ese uso?"""
    return has_key(provider_of(model_for(session, role)))


def text_parse(model: str, prompt: str, schema: type[T], fast: bool = False) -> T:
    """Una pregunta de texto con respuesta estructurada, al proveedor que corresponda al modelo.
    fast = que conteste rápido (la voz): OpenAI piensa lo mínimo."""
    if provider_of(model) == "Gemini":
        return gemini_parse(model, [], prompt, schema)
    return openai_parse(model, prompt, schema, fast=fast)


def _status_error(provider: str, model: str, code: int | None, message: str | None) -> AIError:
    if code in (401, 403) or (code == 400 and "api key" in (message or "").lower()):
        return AIError(f"La clave de {provider} no es válida o no tiene permiso.", 503)
    if code == 404:
        return AIError(f"{provider} no tiene el modelo «{model}». Elijan otro en Ajustes → Casa.", 400)
    if code == 429:
        return AIError(f"{provider} está recibiendo demasiadas solicitudes o se acabó la cuota; intenten en un momento.", 429)
    if code == 400:
        return AIError(f"{provider} rechazó la solicitud: {message or 'solicitud inválida'}", 400)
    return AIError(f"Error del servicio de {provider} ({code}).")


# ---------------------------------------------------------------- Gemini (fotos)

def gemini_parse(model: str, images: list[tuple[bytes, str]], prompt: str, schema: type[T]) -> T:
    key = gemini_key()
    if not key:
        raise AIError("Falta configurar GEMINI_API_KEY para usar Gemini.", 503)
    client = genai.Client(api_key=key)
    parts: list = [genai_types.Part.from_bytes(data=data, mime_type=mt) for data, mt in images]
    parts.append(prompt)
    try:
        response = client.models.generate_content(
            model=model,
            contents=parts,
            config=genai_types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=schema,
                automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )
    except genai_errors.APIError as e:
        raise _status_error("Gemini", model, e.code, e.message) from e
    except (OSError, ValueError) as e:
        log.warning("Gemini: %s", e)
        raise AIError("No se pudo conectar con Gemini.") from e

    feedback = response.prompt_feedback
    if feedback and feedback.block_reason:
        raise AIError("Gemini no quiso procesar esta foto.", 422)
    if response.parsed is None:
        raise AIError("Gemini no dio una respuesta válida; intenten con otra foto.")
    return response.parsed


# ---------------------------------------------------------------- OpenAI (texto)

def openai_parse(model: str, prompt: str, schema: type[T], fast: bool = False) -> T:
    key = openai_key()
    if not key:
        raise AIError("Falta configurar OPENAI_API_KEY para usar OpenAI.", 503)
    client = openai.OpenAI(api_key=key)
    try:
        extra = {}
        if fast and model.startswith(("gpt-5", "o3", "o4")):
            extra["reasoning"] = {"effort": "low"}  # la voz no puede esperar a que piense
        response = client.responses.parse(model=model, input=prompt, text_format=schema, **extra)
    except openai.AuthenticationError as e:
        raise _status_error("OpenAI", model, 401, None) from e
    except openai.NotFoundError as e:
        raise _status_error("OpenAI", model, 404, None) from e
    except openai.RateLimitError as e:
        raise _status_error("OpenAI", model, 429, None) from e
    except openai.BadRequestError as e:
        raise _status_error("OpenAI", model, 400, e.message) from e
    except openai.APIStatusError as e:
        raise _status_error("OpenAI", model, e.status_code, e.message) from e
    except openai.APIConnectionError as e:
        raise AIError("No se pudo conectar con OpenAI.") from e
    except (openai.LengthFinishReasonError, openai.ContentFilterFinishReasonError, openai.APIResponseValidationError,
            ValidationError, ValueError) as e:
        # Respuesta cortada, bloqueada o que no cumple la estructura: se trata como "no entendí".
        log.warning("OpenAI (%s) devolvió algo que no cumple la estructura: %s", model, e)
        raise AIError("OpenAI no dio una respuesta válida.", 422) from e
    except openai.OpenAIError as e:
        raise AIError(f"OpenAI falló: {e}") from e

    parsed = getattr(response, "output_parsed", None)
    if not isinstance(parsed, schema):
        raise AIError("OpenAI no dio una respuesta válida.", 422)
    return parsed


# ---------------------------------------------------------------- modelos disponibles

_MODELS_CACHE: dict[str, tuple[float, list[str]]] = {}
_OPENAI_SKIP = ("audio", "realtime", "tts", "transcribe", "image", "search", "embedding", "moderation", "codex")


def list_models(provider: str) -> list[str]:
    """Modelos que la clave puede usar, para elegir en Ajustes (se guardan 10 minutos)."""
    cached = _MODELS_CACHE.get(provider)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    if not has_key(provider):
        return []
    try:
        if provider == "Gemini":
            client = genai.Client(api_key=gemini_key())
            names = [
                (m.name or "").removeprefix("models/")
                for m in client.models.list()
                if "generateContent" in (m.supported_actions or []) and "gemini" in (m.name or "")
            ]
        else:
            client = openai.OpenAI(api_key=openai_key())
            names = [
                m.id for m in client.models.list()
                if m.id.startswith(("gpt-", "o1", "o3", "o4", "chatgpt"))
                and not any(s in m.id for s in _OPENAI_SKIP)
            ]
    except (genai_errors.APIError, openai.OpenAIError, OSError, ValueError) as e:
        raise AIError(f"No se pudo pedir la lista de modelos a {provider}: {e}") from e
    names = sorted(set(names), reverse=True)
    _MODELS_CACHE[provider] = (time.time(), names)
    return names


def models_for_role(role: str) -> list[str]:
    """Las fotos solo con Gemini; el texto con cualquiera de los dos que tenga clave."""
    providers = ["Gemini"] if ROLES[role]["OpenAI"] is None else ["Gemini", "OpenAI"]
    return [m for p in providers for m in list_models(p)]


class _Ping(BaseModel):
    ok: bool


def test_model(model: str) -> None:
    """Una pregunta mínima para comprobar que la clave y el modelo funcionan."""
    text_parse(model, 'Responde con {"ok": true}.', _Ping)

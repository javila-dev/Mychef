"""Proveedores de IA de la casa: Gemini lee las fotos y OpenAI se encarga del texto.

Las claves van en variables de entorno (GEMINI_API_KEY o GOOGLE_API_KEY, y OPENAI_API_KEY).
El modelo de cada uno se elige en Ajustes y se guarda en la base de datos.
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

DEFAULT_PHOTO_MODEL = os.environ.get("MYCHEF_PHOTO_MODEL", "gemini-2.5-flash")
DEFAULT_TEXT_MODEL = os.environ.get("MYCHEF_TEXT_MODEL", "gpt-5-mini")
MODEL_NAME = re.compile(r"^[\w.\-:/]{2,80}$")

ROLES = {
    "photo": {"provider": "Gemini", "setting": "ai_photo_model", "default": DEFAULT_PHOTO_MODEL,
              "key_env": "GEMINI_API_KEY"},
    "text": {"provider": "OpenAI", "setting": "ai_text_model", "default": DEFAULT_TEXT_MODEL,
             "key_env": "OPENAI_API_KEY"},
}


def model_for(session, role: str) -> str:
    """El modelo elegido en Ajustes para fotos (Gemini) o texto (OpenAI)."""
    from .models import Setting

    s = session.get(Setting, ROLES[role]["setting"])
    return s.value if s and s.value else ROLES[role]["default"]


class AIError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def gemini_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


def openai_key() -> str | None:
    return os.environ.get("OPENAI_API_KEY")


def configured(role: str) -> bool:
    return bool(gemini_key() if role == "photo" else openai_key())


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
        raise AIError("Falta configurar GEMINI_API_KEY para leer fotos con Gemini.", 503)
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

def openai_parse(model: str, prompt: str, schema: type[T]) -> T:
    key = openai_key()
    if not key:
        raise AIError("Falta configurar OPENAI_API_KEY para usar OpenAI.", 503)
    client = openai.OpenAI(api_key=key)
    try:
        response = client.responses.parse(model=model, input=prompt, text_format=schema)
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


def list_models(role: str) -> list[str]:
    """Modelos que la clave puede usar, para elegir en Ajustes (se guardan 10 minutos)."""
    cached = _MODELS_CACHE.get(role)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    if not configured(role):
        return []
    try:
        if role == "photo":
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
        raise AIError(f"No se pudo pedir la lista de modelos a {ROLES[role]['provider']}: {e}") from e
    names = sorted(set(names), reverse=True)
    _MODELS_CACHE[role] = (time.time(), names)
    return names


class _Ping(BaseModel):
    ok: bool


def test_model(role: str, model: str) -> None:
    """Una pregunta mínima para comprobar que la clave y el modelo funcionan."""
    prompt = 'Responde con {"ok": true}.'
    if role == "photo":
        gemini_parse(model, [], prompt, _Ping)
    else:
        openai_parse(model, prompt, _Ping)

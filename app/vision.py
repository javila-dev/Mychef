"""Reconocimiento con Claude: qué hay en la nevera/despensa y recetas escritas a mano.

Necesita ANTHROPIC_API_KEY (o un perfil de `ant auth login`). Sin credenciales,
el resto de la aplicación funciona igual y solo estas funciones quedan deshabilitadas.
"""

from __future__ import annotations

import base64
import os
from typing import Literal

import anthropic
from pydantic import BaseModel

from .models import DISH_TYPES, INGREDIENT_CATEGORIES, MEAL_TYPES

MODEL = os.environ.get("MYCHEF_MODEL", "claude-opus-5")
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class VisionError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class DetectedItem(BaseModel):
    name: str
    quantity: float
    unit: str
    category: str
    confidence: Literal["alta", "media", "baja"]


class PantryDetection(BaseModel):
    items: list[DetectedItem]
    notes: str


class DraftIngredient(BaseModel):
    name: str
    quantity: float
    unit: str
    note: str
    optional: bool


class RecipeDraft(BaseModel):
    name: str
    meal_types: list[str]
    dish_type: str
    servings: int
    prep_minutes: int | None
    ingredients: list[DraftIngredient]
    instructions: str
    notes: str


class ReceiptLine(BaseModel):
    raw_text: str
    name: str
    quantity: float
    unit: str
    category: str
    price: float | None
    kind: Literal["alimento", "hogar", "otro"]


class Receipt(BaseModel):
    store: str
    date: str | None
    total: float | None
    items: list[ReceiptLine]
    notes: str


UNITS_HINT = "g, kg, ml, l, taza, cda, cdta, unidad, lb, oz, o una unidad propia como 'diente', 'pizca', 'atado'"


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic()


def _image_block(data: bytes, media_type: str) -> dict:
    if media_type not in IMAGE_TYPES:
        raise VisionError("Formato de imagen no soportado. Usa JPG, PNG, WEBP o GIF.", 400)
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError("La imagen pesa más de 5 MB; tómala con menor resolución.", 400)
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": base64.standard_b64encode(data).decode("utf-8"),
        },
    }


def _parse(content: list[dict], output_format: type[BaseModel]):
    try:
        response = _client().beta.messages.parse(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": content}],
            output_format=output_format,
        )
    except anthropic.AuthenticationError as e:
        raise VisionError(
            "Falta configurar ANTHROPIC_API_KEY para usar el reconocimiento por foto.", 503
        ) from e
    except anthropic.RateLimitError as e:
        raise VisionError("Demasiadas solicitudes; intenta de nuevo en un momento.", 429) from e
    except anthropic.APIStatusError as e:
        raise VisionError(f"Error del servicio de reconocimiento ({e.status_code}).") from e
    except anthropic.APIConnectionError as e:
        raise VisionError("No se pudo conectar con el servicio de reconocimiento.") from e
    except TypeError as e:
        if "authentication" not in str(e):
            raise
        raise VisionError(  # sin credenciales configuradas
            "Falta configurar ANTHROPIC_API_KEY para usar el reconocimiento por foto.", 503
        ) from e

    if response.stop_reason == "refusal":
        raise VisionError("El modelo no pudo procesar esta solicitud.", 422)
    if response.parsed_output is None:
        raise VisionError("No se obtuvo una respuesta válida; intenta con otra foto.")
    return response.parsed_output


def detect_pantry(data: bytes, media_type: str, known_ingredients: list[str]) -> PantryDetection:
    known = ", ".join(sorted(known_ingredients)) or "(todavía no hay ingredientes registrados)"
    prompt = f"""Esta es una foto de la nevera, alacena o compras de una familia. \
Lista los alimentos e ingredientes que se ven, estimando la cantidad de cada uno.

Ingredientes que esta familia ya usa en sus recetas: {known}.
Si reconoces uno de ellos, usa exactamente ese nombre para que coincida con sus recetas. \
Si es algo nuevo, usa un nombre corto en español y en singular (p. ej. "tomate", "leche").

Reglas:
- unit: una de {UNITS_HINT}. Prefiere "unidad" para cosas que se cuentan (huevos, limones) \
y g/ml cuando la etiqueta o el envase deja ver el peso o volumen.
- category: una de {", ".join(INGREDIENT_CATEGORIES)}.
- confidence: "alta" si se ve con claridad, "media" si lo deduces del envase, "baja" si es una suposición.
- No inventes cosas que no se vean. Agrupa artículos iguales en una sola línea.
- notes: una frase corta sobre lo que no se pudo identificar bien (o vacío)."""
    return _parse([_image_block(data, media_type), {"type": "text", "text": prompt}], PantryDetection)


def parse_recipe(
    text: str | None, image: tuple[bytes, str] | None, known_ingredients: list[str]
) -> RecipeDraft:
    known = ", ".join(sorted(known_ingredients)) or "(ninguno todavía)"
    prompt = f"""Convierte esta receta casera a un formato estructurado, respetando \
EXACTAMENTE las cantidades y proporciones que escribió la familia. No la cambies por una receta \
genérica ni agregues ingredientes que no estén.

Ingredientes que la familia ya tiene registrados: {known}. Si un ingrediente coincide, usa ese nombre.

Reglas:
- servings: para cuántas porciones está escrita (si no se dice, estima por las cantidades).
- meal_types: uno o varios de {", ".join(MEAL_TYPES)}.
- dish_type: uno de {", ".join(DISH_TYPES)}.
- unit: una de {UNITS_HINT}. "al gusto" -> quantity 0, unit "pizca", optional true, note "al gusto".
- Fracciones como "1/2 taza" -> quantity 0.5, unit "taza".
- note: preparación del ingrediente ("picado", "en cubos") o vacío.
- instructions: los pasos numerados, uno por línea, con las palabras de la familia.
- notes: trucos o comentarios que aparezcan (o vacío)."""
    content: list[dict] = []
    if image:
        content.append(_image_block(*image))
    if text:
        content.append({"type": "text", "text": f"<receta>\n{text}\n</receta>"})
    if not content:
        raise VisionError("Envía el texto o una foto de la receta.", 400)
    content.append({"type": "text", "text": prompt})
    return _parse(content, RecipeDraft)


def scan_receipt(images: list[tuple[bytes, str]], known_ingredients: list[str]) -> Receipt:
    """Lee una factura de supermercado (una o varias fotos de la misma factura)."""
    if not images:
        raise VisionError("Toma al menos una foto de la factura.", 400)
    if len(images) > 6:
        raise VisionError("Máximo 6 fotos por factura.", 400)
    known = ", ".join(sorted(known_ingredients)) or "(todavía no hay productos registrados)"
    prompt = f"""{"Estas fotos son partes de UNA MISMA factura" if len(images) > 1 else "Esta foto es una factura"} \
de compras de una familia (supermercado, tienda, plaza de mercado o domicilio).

Extrae cada producto comprado para llevarlo al inventario de la casa.

Productos que la familia ya tiene registrados: {known}.
Las facturas usan nombres abreviados ("LCHE ALQ 1100ML", "PAP HIG FAM X12"). Tradúcelos a un nombre \
corto y claro en español, en singular. Si corresponde a uno de los productos registrados, usa \
EXACTAMENTE ese nombre para que coincida con sus recetas (p. ej. "ARROZ DIANA 1000G" -> "Arroz").

Reglas:
- raw_text: la línea tal como aparece en la factura.
- quantity y unit: la cantidad REAL de producto, no el número de paquetes. Multiplica paquetes \
por contenido: 2 x "LECHE 1100ML" -> quantity 2200, unit "ml"; "HUEVO AA X30" -> 30 unidad; \
"PAPA 1.250 KG" -> 1250 g. Unidades: {UNITS_HINT}. Si no se sabe el contenido, usa la cantidad \
de paquetes con unit "unidad".
- category: una de {", ".join(INGREDIENT_CATEGORIES)}.
- price: valor total pagado por esa línea (número, sin símbolos ni separador de miles), o null.
- kind: "alimento" para comida y bebidas, "hogar" para aseo, limpieza, cuidado personal y \
cosas de la casa, "otro" para lo demás (bolsas, propinas, domicilio, descuentos).
- Agrupa líneas repetidas del mismo producto. No incluyas subtotales, impuestos, ni medios de pago.
- store: nombre del almacén. date: fecha de la compra en formato AAAA-MM-DD, o null.
- total: total pagado, o null.
- notes: una frase corta si algo no se pudo leer bien (o vacío)."""
    content = [_image_block(data, mt) for data, mt in images]
    content.append({"type": "text", "text": prompt})
    return _parse(content, Receipt)

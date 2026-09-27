"""Reconocimiento con IA: facturas, nevera/despensa y recetas (fotos con Gemini) y frases
de voz difíciles o recetas escritas (texto con OpenAI). Ver app/ai.py para claves y modelos.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from . import ai
from .ai import AIError as VisionError  # noqa: F401  (nombre usado por el resto de la app)
from .models import DISH_TYPES, INGREDIENT_CATEGORIES, MEAL_TYPES

IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class DetectedItem(BaseModel):
    name: str
    quantity: float
    unit: str
    category: str
    confidence: Literal["alta", "media", "baja"]
    # Dónde está en las fotos, para marcarlo encima: número de foto (0 = la primera) y el centro
    # del artículo en milésimas del ancho (x) y del alto (y). -1 si no se puede señalar.
    photo: int
    x: float
    y: float


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


def _check_image(data: bytes, media_type: str) -> tuple[bytes, str]:
    if media_type not in IMAGE_TYPES:
        raise VisionError("Formato de imagen no soportado. Usa JPG, PNG, WEBP o GIF.", 400)
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError("La imagen pesa más de 5 MB; tómala con menor resolución.", 400)
    return data, media_type


def detect_pantry(
    images: list[tuple[bytes, str]], known_ingredients: list[str], place: str = "nevera",
    model: str | None = None,
) -> PantryDetection:
    known = ", ".join(sorted(known_ingredients)) or "(todavía no hay ingredientes registrados)"
    where = {"nevera": "la nevera (puede incluir la puerta y el congelador)", "alacena": "la alacena o despensa"}.get(
        place, "la nevera, alacena o compras"
    )
    fotos = "Estas fotos son" if len(images) > 1 else "Esta foto es"
    prompt = f"""{fotos} de {where} de una familia. \
Lista los alimentos e ingredientes que se ven, estimando cuánto QUEDA de cada uno.

Ingredientes que esta familia ya usa en sus recetas: {known}.
Si reconoces uno de ellos, usa exactamente ese nombre para que coincida con sus recetas. \
Si es algo nuevo, usa un nombre corto en español y en singular (p. ej. "tomate", "leche").

Reglas:
- unit: una de {UNITS_HINT}. Prefiere "unidad" para cosas que se cuentan (huevos, limones) \
y g/ml cuando la etiqueta o el envase deja ver el peso o volumen.
- Envases abiertos: estima lo que queda (una caja de leche de 1 l a la mitad = 500 ml).
- Si varias fotos muestran lo mismo (p. ej. la nevera y su puerta), no lo cuentes dos veces.
- Recipientes cerrados u opacos (tuppers, bolsas sin rótulo): inclúyelos solo si se adivina qué son, \
con confidence "baja". No incluyas platos ya preparados como ingredientes.
- category: una de {", ".join(INGREDIENT_CATEGORIES)}.
- confidence: "alta" si se ve con claridad, "media" si lo deduces del envase, "baja" si es una suposición.
- No inventes cosas que no se vean. Agrupa artículos iguales en una sola línea.
- photo, x, y: dónde está, para poner un marcador encima. photo es el número de la foto \
(0 = la primera, en el orden en que llegaron). x, y es el centro del artículo en esa foto, en milésimas: \
x = 0 borde izquierdo, 1000 borde derecho; y = 0 borde de arriba, 1000 borde de abajo. \
Si agrupaste varios iguales, señala uno de ellos. Si no puedes señalarlo, usa -1 en los tres.
- notes: una frase corta sobre lo que no se pudo identificar bien (o vacío)."""
    if not images:
        raise VisionError("Envíen al menos una foto.", 400)
    checked = [_check_image(data, media_type) for data, media_type in images]
    return ai.gemini_parse(model or ai.DEFAULT_PHOTO_MODEL, checked, prompt, PantryDetection)


def parse_recipe(
    text: str | None, image: tuple[bytes, str] | None, known_ingredients: list[str],
    photo_model: str | None = None, text_model: str | None = None,
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
    if not image and not text:
        raise VisionError("Envía el texto o una foto de la receta.", 400)
    full = (f"<receta>\n{text}\n</receta>\n\n" if text else "") + prompt
    if image:  # foto (con o sin texto): Gemini
        return ai.gemini_parse(photo_model or ai.DEFAULT_PHOTO_MODEL, [_check_image(*image)], full, RecipeDraft)
    return ai.openai_parse(text_model or ai.DEFAULT_TEXT_MODEL, full, RecipeDraft)


def scan_receipt(
    images: list[tuple[bytes, str]], known_ingredients: list[str], model: str | None = None
) -> Receipt:
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
    checked = [_check_image(data, mt) for data, mt in images]
    return ai.gemini_parse(model or ai.DEFAULT_PHOTO_MODEL, checked, prompt, Receipt)


class VoiceCanonical(BaseModel):
    command: str | None


def voice_canonical(
    text: str, recipes: list[str], chores: list[str], screen: str, model: str | None = None
) -> str | None:
    """Reescribe una frase dicha en la cocina como uno de los comandos que la casa entiende."""
    prompt = f"""Alguien de la familia le habló a la pantalla de la cocina. El reconocimiento de voz \
entendió: <frase>{text}</frase>
Pantalla actual: {screen}. Recetas de la casa: {", ".join(recipes) or "(ninguna)"}. \
Tareas de la casa: {", ".join(chores) or "(ninguna)"}.

Reescribe la intención como UNO de estos comandos, en español, con los nombres reales de arriba:
- "se acabó <productos separados por coma>"
- "agrega <productos separados por coma> a la lista"
- "ya hice <nombre exacto de la tarea>"
- "qué hay de <desayuno|almuerzo|cena|comer>"
- "qué cocino" o "qué hago de <comida>"
- "abre la receta de <nombre exacto de la receta>"
- "temporizador de <N> minutos para <qué>"
- "cancela el temporizador"
- "qué falta comprar", "qué se vence", "qué tareas hay"
- en modo cocina: "siguiente", "anterior", "repite", "cuánto <ingrediente> lleva", "ingredientes"
Si la frase no pide nada de esto o es ruido, command = null. No inventes productos ni tareas."""
    result = ai.openai_parse(model or ai.DEFAULT_TEXT_MODEL, prompt, VoiceCanonical)
    return result.command

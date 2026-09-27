"""Unidades de medida y conversiones.

Cada unidad pertenece a una dimensión (masa, volumen, conteo). Solo se puede
convertir dentro de la misma dimensión; una unidad desconocida (p. ej. "diente",
"pizca", "atado") es su propia dimensión y solo se compara consigo misma.
"""

from __future__ import annotations

import unicodedata

# unidad canónica -> (dimensión, factor a la unidad base de la dimensión)
UNITS: dict[str, tuple[str, float]] = {
    "g": ("masa", 1.0),
    "kg": ("masa", 1000.0),
    "lb": ("masa", 453.592),
    "oz": ("masa", 28.3495),
    "ml": ("volumen", 1.0),
    "l": ("volumen", 1000.0),
    "taza": ("volumen", 240.0),
    "cda": ("volumen", 15.0),
    "cdta": ("volumen", 5.0),
    "unidad": ("conteo", 1.0),
    "docena": ("conteo", 12.0),
}

BASE_UNIT = {"masa": "g", "volumen": "ml", "conteo": "unidad"}

ALIASES: dict[str, str] = {
    "gr": "g", "grs": "g", "gramo": "g", "gramos": "g",
    "kilo": "kg", "kilos": "kg", "kilogramo": "kg", "kilogramos": "kg",
    "libra": "lb", "libras": "lb", "lbs": "lb",
    "onza": "oz", "onzas": "oz",
    "mililitro": "ml", "mililitros": "ml", "cc": "ml",
    "litro": "l", "litros": "l", "lt": "l", "lts": "l",
    "tazas": "taza", "tz": "taza",
    "cucharada": "cda", "cucharadas": "cda", "cdas": "cda",
    "cucharadita": "cdta", "cucharaditas": "cdta", "cdtas": "cdta",
    "u": "unidad", "un": "unidad", "und": "unidad", "unidades": "unidad",
    "pieza": "unidad", "piezas": "unidad",
    "docenas": "docena",
}


def strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn"
    )


def normalize_unit(unit: str | None) -> str:
    u = strip_accents((unit or "").strip().lower()).rstrip(".")
    if not u:
        return "unidad"
    return ALIASES.get(u, u)


def dimension(unit: str) -> str:
    u = normalize_unit(unit)
    return UNITS[u][0] if u in UNITS else f"otra:{u}"


def to_base(quantity: float, unit: str) -> tuple[float, str]:
    """Convierte a la unidad base de su dimensión. Devuelve (cantidad, unidad_base)."""
    u = normalize_unit(unit)
    if u in UNITS:
        dim, factor = UNITS[u]
        return quantity * factor, BASE_UNIT[dim]
    return quantity, u


def convert(quantity: float, from_unit: str, to_unit: str) -> float | None:
    """Convierte entre unidades de la misma dimensión; None si no es posible."""
    f, t = normalize_unit(from_unit), normalize_unit(to_unit)
    if f == t:
        return quantity
    if f in UNITS and t in UNITS and UNITS[f][0] == UNITS[t][0]:
        return quantity * UNITS[f][1] / UNITS[t][1]
    return None


def humanize(quantity: float, unit: str) -> tuple[float, str]:
    """Expresa cantidades base de forma legible (1500 g -> 1.5 kg)."""
    u = normalize_unit(unit)
    if u == "g" and quantity >= 1000:
        return round(quantity / 1000, 2), "kg"
    if u == "ml" and quantity >= 1000:
        return round(quantity / 1000, 2), "l"
    return round(quantity, 2), u


def to_grams(
    quantity: float, unit: str, g_per_ml: float | None = None, g_per_unit: float | None = None
) -> float | None:
    u = normalize_unit(unit)
    if u not in UNITS:
        return None
    dim, factor = UNITS[u]
    base = quantity * factor
    if dim == "masa":
        return base
    if dim == "volumen" and g_per_ml:
        return base * g_per_ml
    if dim == "conteo" and g_per_unit:
        return base * g_per_unit
    return None


def from_grams(
    grams: float, unit: str, g_per_ml: float | None = None, g_per_unit: float | None = None
) -> float | None:
    one = to_grams(1, unit, g_per_ml, g_per_unit)
    return grams / one if one else None


def convert_with(
    quantity: float,
    from_unit: str,
    to_unit: str,
    g_per_ml: float | None = None,
    g_per_unit: float | None = None,
) -> float | None:
    """Como convert(), pero cruza dimensiones usando las equivalencias del ingrediente
    (p. ej. 1 taza de arroz = 200 g, 1 zanahoria = 80 g)."""
    direct = convert(quantity, from_unit, to_unit)
    if direct is not None:
        return direct
    grams = to_grams(quantity, from_unit, g_per_ml, g_per_unit)
    if grams is None:
        return None
    return from_grams(grams, to_unit, g_per_ml, g_per_unit)

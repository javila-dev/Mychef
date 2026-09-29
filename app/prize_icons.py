"""Íconos a color para los premios de los niños.

Los que vienen con la app (static/prizes, Fluent Emoji de Microsoft, licencia MIT) funcionan sin
internet. Desde Administrar → Premios se pueden buscar más en Fluent Emoji y en Noto Emoji (Google,
Apache 2.0) a través de la API pública de Iconify; el que se elige se descarga y se guarda en la casa,
así la tablet lo sigue mostrando aunque se caiga el internet.

La búsqueda de Iconify es en inglés: las palabras en español se traducen con el diccionario de abajo.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from .units import strip_accents

API = "https://api.iconify.design"
SETS = ("fluent-emoji-flat", "noto")
ICON_ID = re.compile(r"^(fluent-emoji-flat|noto):[a-z0-9]+(-[a-z0-9]+)*$")
# Variantes de tono de piel y otras repeticiones que llenan los resultados sin aportar
SKIN = re.compile(r"-(light|medium-light|medium|medium-dark|dark)(-|$)")
BUNDLED_DIR = Path(__file__).resolve().parent.parent / "static" / "prizes"
MAX_SVG_BYTES = 200_000

# Los que vienen con la app: (ícono, nombre sugerido). Experiencias antes que cosas.
PRIZES = [
    ("fluent-emoji-flat:ice-cream", "Un helado"),
    ("fluent-emoji-flat:playground-slide", "Ir al parque"),
    ("fluent-emoji-flat:popcorn", "Elegir la película"),
    ("fluent-emoji-flat:pizza", "Noche de pizza"),
    ("fluent-emoji-flat:person-swimming", "Ir a la piscina"),
    ("fluent-emoji-flat:bicycle", "Paseo en bici"),
    ("fluent-emoji-flat:cookie", "Hornear galletas"),
    ("fluent-emoji-flat:video-game", "Media hora más de juego"),
    ("fluent-emoji-flat:tent", "Pijamada en la sala"),
    ("fluent-emoji-flat:teddy-bear", "Un juguete pequeño"),
    ("fluent-emoji-flat:birthday-cake", "Postre favorito"),
    ("fluent-emoji-flat:open-book", "Un cuento nuevo"),
    ("fluent-emoji-flat:balloon", "Una bomba"),
    ("fluent-emoji-flat:kite", "Elevar cometa"),
    ("fluent-emoji-flat:doughnut", "Una dona"),
    ("fluent-emoji-flat:hamburger", "Salir a comer hamburguesa"),
    ("fluent-emoji-flat:lollipop", "Un dulce"),
    ("fluent-emoji-flat:chocolate-bar", "Un chocolate"),
    ("fluent-emoji-flat:ferris-wheel", "Ir a los juegos"),
    ("fluent-emoji-flat:beach-with-umbrella", "Paseo a la playa"),
    ("fluent-emoji-flat:soccer-ball", "Jugar fútbol con papá"),
    ("fluent-emoji-flat:artist-palette", "Tarde de pintar"),
    ("fluent-emoji-flat:circus-tent", "Ir al circo"),
    ("fluent-emoji-flat:puzzle-piece", "Un rompecabezas"),
]

# Español → inglés para la búsqueda (sin tildes; singular). Varias opciones con «|»: se buscan todas.
WORDS = {
    "helado": "ice cream", "paleta": "ice cream", "cono": "ice cream", "parque": "playground|national park|tree", "rodadero": "slide",
    "columpio": "playground", "pelicula": "movie", "cine": "cinema", "crispeta": "popcorn", "palomita": "popcorn",
    "pizza": "pizza", "piscina": "swimming", "nadar": "swimming", "bici": "bicycle", "bicicleta": "bicycle",
    "galleta": "cookie", "juego": "game", "videojuego": "video game", "consola": "video game", "tablet": "mobile phone",
    "celular": "mobile phone", "television": "television", "tele": "television", "pijamada": "tent", "carpa": "tent",
    "juguete": "teddy bear|yo-yo|kite|puzzle|racing car", "oso": "teddy bear", "peluche": "teddy bear", "muneca": "doll|teddy bear", "carro": "racing car|automobile", "carrito": "racing car",
    "tren": "train", "avion": "airplane", "barco": "boat", "cohete": "rocket", "robot": "robot", "dinosaurio": "t-rex|sauropod",
    "torta": "cake", "pastel": "cake", "ponque": "cake", "cumpleanos": "birthday", "postre": "dessert", "cuento": "book",
    "libro": "book", "bomba": "balloon", "globo": "balloon", "cometa": "kite", "dona": "doughnut", "hamburguesa": "hamburger",
    "papa": "fries", "papas": "fries", "salchipapa": "fries", "perro caliente": "hot dog", "dulce": "candy|lollipop", "chupeta": "lollipop",
    "bombon": "lollipop", "chocolate": "chocolate", "gomita": "candy", "juegos": "ferris wheel|roller coaster|carousel", "feria": "ferris wheel",
    "montana rusa": "roller coaster", "playa": "beach", "mar": "beach", "futbol": "soccer", "balon": "soccer ball",
    "pelota": "ball", "baloncesto": "basketball", "pintar": "artist palette", "pintura": "artist palette", "dibujar": "crayon",
    "colores": "crayon", "circo": "circus", "payaso": "clown", "rompecabezas": "puzzle", "lego": "brick", "fichas": "puzzle",
    "musica": "music", "cancion": "music", "guitarra": "guitar", "bailar": "dancing|mirror ball", "baile": "dancing|mirror ball", "zoologico": "lion|elephant|giraffe|monkey",
    "animal": "dog|cat|rabbit|lion", "perro": "dog", "gato": "cat", "caballo": "horse", "pez": "fish", "acuario": "fish", "granja": "cow|pig|chicken|horse",
    "mascota": "dog", "campamento": "camping", "fogata": "campfire", "montana": "mountain", "paseo": "automobile|bicycle|park", "viaje": "airplane",
    "estrella": "star", "corona": "crown", "trofeo": "trophy", "medalla": "medal", "regalo": "gift", "sorpresa": "gift",
    "fiesta": "party popper|balloon|confetti", "abrazo": "hugging", "beso": "kiss", "dinero": "money", "moneda": "coin", "alcancia": "piggy bank",
    "fruta": "strawberry|banana|watermelon|grapes", "fresa": "strawberry", "banano": "banana", "sandia": "watermelon", "jugo": "juice", "malteada": "milkshake",
    "cereal": "cereal", "panqueque": "pancakes", "waffle": "waffle", "sushi": "sushi", "arepa": "flatbread", "empanada": "dumpling",
    "patineta": "skateboard", "patines": "roller skate", "trampolin": "trampoline", "carpa de circo": "circus",
    "disfraz": "mask", "magia": "magic wand", "mago": "magic wand", "princesa": "princess", "superheroe": "superhero|mage",
    "unicornio": "unicorn", "arcoiris": "rainbow", "sol": "sun", "luna": "moon", "nieve": "snowman", "lluvia": "umbrella",
}


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", strip_accents(text.strip().lower()))


def translate(query: str) -> str:
    """«Helados de chocolate» → «ice cream chocolate». Lo que no conoce lo deja igual (puede venir en inglés).
    Si una palabra tiene varias opciones («t-rex|sauropod»), sale con «|» y search() busca cada una."""
    q = _norm(query)
    if q in WORDS:
        return WORDS[q]
    out = []
    for w in q.split(" "):
        if w in {"de", "del", "la", "el", "los", "las", "un", "una", "con", "y", "al", "a", "para"}:
            continue
        base = w[:-2] if w.endswith("es") and w[:-2] in WORDS else w[:-1] if w.endswith("s") and w[:-1] in WORDS else w
        out.append(WORDS.get(base, w))
    return " ".join(out) or q


def bundled_path(icon_id: str) -> Path | None:
    if not ICON_ID.match(icon_id or ""):
        return None
    path = BUNDLED_DIR / (icon_id.replace(":", "--") + ".svg")
    return path if path.exists() else None


def bundled_url(icon_id: str) -> str | None:
    path = bundled_path(icon_id)
    return f"/static/prizes/{path.name}" if path else None


def preview_url(icon_id: str) -> str:
    prefix, name = icon_id.split(":", 1)
    return f"{API}/{prefix}/{name}.svg"


def _get(url: str, timeout: float = 8) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "mychef-casa"})
    with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (URL fija de Iconify)
        return res.read(MAX_SVG_BYTES + 1)


def search(query: str, limit: int = 48) -> list[str]:
    """Íconos a color que coinciden (primero Fluent, después Noto), sin variantes de tono de piel."""
    q = translate(query)
    if not q:
        return []
    found: list[str] = []
    # «helado|dona» o «t-rex|sauropod chocolate»: cada opción se busca aparte y se juntan
    words = q.split(" ")
    alts = next((w.split("|") for w in words if "|" in w), None)
    queries = [" ".join(a if "|" in w else w for w in words) for a in alts] if alts else [q]
    for one in queries[:5]:
        url = f"{API}/search?" + urllib.parse.urlencode({"query": one, "prefixes": ",".join(SETS), "limit": 96})
        found += json.loads(_get(url)).get("icons", [])
    seen, out = set(), []
    order = {icon_id: n for n, icon_id in enumerate(found)}
    for icon_id in sorted(set(found), key=lambda i: (SETS.index(i.split(":")[0]) if i.split(":")[0] in SETS else 9, order[i])):
        if not ICON_ID.match(icon_id) or SKIN.search(icon_id.split(":")[1]):
            continue
        name = icon_id.split(":")[1]
        if name in seen:  # el mismo dibujo en las dos colecciones: basta uno
            continue
        seen.add(name)
        out.append(icon_id)
    return out[:limit]


def download(icon_id: str) -> bytes:
    """El SVG del ícono, revisado: solo dibujo, nada de scripts ni enlaces."""
    if not ICON_ID.match(icon_id or ""):
        raise ValueError("Ese ícono no existe.")
    svg = _get(preview_url(icon_id))
    if len(svg) > MAX_SVG_BYTES or not svg.lstrip().startswith(b"<svg"):
        raise ValueError("Ese ícono no se pudo usar.")
    low = svg.lower()
    if b"<script" in low or b"javascript:" in low or re.search(rb"\son[a-z]+\s*=", low) or b"<foreignobject" in low:
        raise ValueError("Ese ícono no se pudo usar.")
    return svg

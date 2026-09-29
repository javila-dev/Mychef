"""Comandos de voz de la casa.

El navegador convierte la voz en texto (Web Speech API) y lo manda aquí. Este módulo entiende
frases en español coloquial con reglas locales (rápido, sin costo y sin internet) y ejecuta lo que
toca: anotar en la lista, "se acabó", marcar tareas, leer el menú, abrir recetas, temporizadores…

Si ninguna regla entiende la frase y hay clave de OpenAI, el modelo elegido en Ajustes la reescribe
como uno de los comandos conocidos y se vuelve a interpretar. Cada acción que cambia datos devuelve cómo
deshacerla, por si el micrófono entendió mal.
"""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
from dataclasses import dataclass, field

from sqlmodel import Session, select

from . import agenda, ai, clock, gcal, household, leftovers, rewards, services
from .models import (
    Chore, Event, Ingredient, Leftover, Member, MenuEntry, MenuLeftover, PantryItem, Recipe, ShoppingExtra,
)
from .units import strip_accents

MEALS = ["desayuno", "almuerzo", "merienda", "cena"]

HELP = (
    "Pueden decir, por ejemplo: se acabó la leche; agrega pan a la lista; ya compré el pan; ¿hay huevos?; "
    "ya saqué la basura; ¿qué hay de almuerzo mañana?; ¿qué cocino?; abre la receta de lentejas; "
    "pon lentejas el jueves de almuerzo; guardé frijoles en el congelador; hoy cenamos sobras de bolognesa; "
    "ya nos comimos los frijoles; ¿qué sobras hay?; ¿cuántas estrellas tiene Benja?; "
    "pon un temporizador de diez minutos para el arroz; recuérdame la cita de Benja el jueves a las 3; "
    "¿qué hay en la agenda? Cocinando: siguiente, repite, "
    "¿cuánto arroz lleva?"
)

NUMBER_WORDS = {
    "un": 1, "una": 1, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6,
    "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12, "trece": 13,
    "catorce": 14, "quince": 15, "dieciseis": 16, "diecisiete": 17, "dieciocho": 18,
    "diecinueve": 19, "veinte": 20, "veintiuno": 21, "veintidos": 22, "veintitres": 23,
    "veinticuatro": 24, "veinticinco": 25, "treinta": 30, "cuarenta": 40, "cincuenta": 50,
    "sesenta": 60, "noventa": 90,
}

STOPWORDS = {
    "el", "la", "los", "las", "de", "del", "a", "al", "en", "y", "un", "una", "unos", "unas",
    "que", "ya", "lo", "le", "se", "por", "para", "con", "mas", "hay", "mi", "su", "sus", "mis",
    "todo", "toda", "todos", "todas", "hoy", "favor", "porfa", "porfavor", "nos",
}


@dataclass
class VoiceResult:
    intent: str
    speak: str
    navigate: dict | None = None
    undo: dict | None = None
    data: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "intent": self.intent, "speak": self.speak, "navigate": self.navigate,
            "undo": self.undo, "data": self.data,
        }


# ---------------------------------------------------------------- texto


def soft(text: str) -> str:
    """Minúsculas y sin signos, pero con tildes y comas (para guardar los nombres tal cual)."""
    t = unicodedata.normalize("NFC", text.lower())
    t = re.sub(r"[¿?¡!.;:\"']", " ", t)
    t = re.sub(r"\s*,\s*", ", ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # saludos y cortesía que no cambian el sentido
    t = re.sub(r"^(oye |hola )?(casa|mychef|nevera)\b,? ?", "", t)
    t = re.sub(r",? ?\b(por favor|porfa|porfavor)\b", "", t)
    return re.sub(r"\s+", " ", t).strip(" ,")


def normalize(text: str) -> str:
    """Como soft() pero sin tildes, para comparar. Conserva las posiciones de soft()."""
    return strip_accents(soft(text))


def _num(word: str) -> float | None:
    if re.fullmatch(r"\d+([.,]\d+)?", word):
        return float(word.replace(",", "."))
    return NUMBER_WORDS.get(word)


def parse_duration(t: str) -> int | None:
    """Segundos a partir de frases como 'diez minutos', 'media hora', 'una hora y media'."""
    total = 0.0
    found = False
    if re.search(r"\bmedia hora\b", t):
        total += 1800
        found = True
    if re.search(r"\bun cuarto de hora\b", t):
        total += 900
        found = True
    for m in re.finditer(r"\b(\d+(?:[.,]\d+)?|[a-z]+(?: y [a-z]+)?) (horas?|minutos?|mins?|segundos?)\b( y media)?", t):
        words = m.group(1)
        value = _num(words)
        if value is None and " y " in words:  # "treinta y cinco"
            a, b = words.split(" y ", 1)
            if _num(a) is not None and _num(b) is not None:
                value = _num(a) + _num(b)
        if value is None:
            continue
        unit = m.group(2)
        mult = 3600 if unit.startswith("hora") else 60 if unit.startswith("min") else 1
        if m.group(3):
            value += 0.5
        total += value * mult
        found = True
    return int(total) if found and total > 0 else None


def _stem(word: str) -> str:
    return word[:5] if len(word) > 5 else word


def _tokens(text: str) -> list[str]:
    return [w for w in normalize(text).split() if w not in STOPWORDS and len(w) > 2]


def _match_score(query: str, candidate: str) -> float:
    """Qué tanto se parecen dos frases por raíces de palabras (0 = nada)."""
    q = {_stem(w) for w in _tokens(query)}
    c = [_stem(w) for w in _tokens(candidate)]
    if not q or not c:
        return 0.0
    hits = sum(1 for w in c if w in q or any(w[:4] == x[:4] for x in q))
    return hits / len(c)


def _split_items(text: str) -> list[str]:
    parts = re.split(r",| y | e |\bademás\b|\bademas\b|\btambién\b|\btambien\b", text)
    items = []
    for p in parts:
        p = re.sub(r"^(de |del |la |el |los |las |un |una |unos |unas |mas |más |otro |otra |y )+", "", p.strip())
        p = re.sub(r"\s+(a|en|para) la lista( de (compras|mercado))?$", "", p)
        p = re.sub(r"\s+(por favor)$", "", p)
        if p:
            items.append(p.strip())
    return items


def _nice(name: str) -> str:
    return name[:1].upper() + name[1:]


def _list(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " y " + items[-1]


# ---------------------------------------------------------------- interpretar


def interpret(session: Session, text: str, context: dict | None = None, today: dt.date | None = None) -> VoiceResult:
    context = context or {}
    today = today or clock.today()
    o = soft(text)
    t = strip_accents(o)
    if not t:
        return VoiceResult("none", "No escuché nada. Intenten de nuevo.")

    pending = context.get("pending")
    if isinstance(pending, dict) and pending.get("kind") == "agenda":
        answered = _agenda_answer(session, o, t, today, pending)
        if answered is not None:
            return answered

    result = _rules(session, t, context, today, o)
    if result is not None:
        return result

    # Nada coincidió: pedirle a la IA (OpenAI) que lo reescriba como un comando conocido (si hay clave).
    # En manos libres no: ahí se oye de todo (hasta la propia voz de la tablet) y solo cuentan comandos.
    canonical = None if context.get("handsfree") else _ai_canonical(session, text, context)
    if canonical:
        again = _rules(session, normalize(canonical), context, today, soft(canonical))
        if again is not None:
            again.data["understood_as"] = canonical
            return again
    return VoiceResult("unknown", f"No entendí «{text.strip()}». {HELP}")


def _rules(session: Session, t: str, ctx: dict, today: dt.date, o: str | None = None) -> VoiceResult | None:
    o = o if o is not None and len(o) == len(t) else t
    orig = lambda m, g=1: o[m.start(g):m.end(g)]  # noqa: E731  (mismo tramo, con tildes)
    screen = ctx.get("screen") or "home"

    if re.search(r"\b(ayuda|que puedo decir|que se puede decir|que comandos|como funciona)\b", t):
        return VoiceResult("help", HELP)

    if re.search(r"^(deshacer|deshaz|me equivoque|eso no|cancela eso|borra eso|no era eso)\b", t):
        return VoiceResult("undo", "Listo, lo deshice.")

    # ------------------------------------------------ comida: sobras y poner en el menú
    # (antes de la agenda: «pon lentejas el jueves de almuerzo» es del menú, no un recordatorio)
    if not (screen == "cook" and re.search(r"\bcuant", t)):
        food = _food_rules(session, o, t, today)
        if food is not None:
            return food

    # ------------------------------------------------ agenda familiar
    # «recuérdame la cita de Benja el jueves a las 3» (pero «recuérdame en 10 minutos…» es un temporizador)
    if re.match(agenda.TRIGGER, t) and not parse_duration(t):
        res = _agenda_add(session, o, t, today, ctx)
        if res:
            return res
    if re.search(r"\b(agenda|calendario|citas|compromisos|cumpleanos)\b", t) and re.search(
        r"\b(que|cuales|cual|ver|abre|abrir|muestra|muestrame|leeme|lee|dime|hay|tenemos)\b", t
    ) or re.search(r"^que (tenemos|hay que hacer) (hoy|manana|pasado manana|esta semana)$", t):
        days = 1 if re.search(r"\bhoy\b", t) else 2 if re.search(r"\bmanana\b", t) else 7
        res = VoiceResult("agenda", agenda.summary(session, today, days))
        if re.search(r"\b(ver|abre|abrir|muestra|muestrame)\b", t):
            res.navigate = {"screen": "agenda"}
        return res
    if re.search(r"^(abre |ver |muestra )?(la )?(agenda|calendario)$", t):
        return VoiceResult("navigate", "", navigate={"screen": "agenda"})

    # ------------------------------------------------ temporizadores
    if re.search(r"\b(cancela|cancelar|quita|quitar|apaga|apagar|deten|detener|para|parar|borra)\b.*\b(temporizador|temporizadores|alarma|alarmas|timer|cronometro)\b", t):
        return VoiceResult("timer_cancel", "Listo, quité el temporizador.")
    if re.search(r"\bcuanto (falta|le falta|queda|le queda)\b", t) and not re.search(r"\b(comprar|compra)\b", t):
        return VoiceResult("timer_query", "")
    if re.search(r"\b(temporizador|alarma|timer|cronometro|avisame|avisanos|recuerdame|cuenta)\b", t) or (
        re.search(r"^(pon|ponme|programa|pone)\b", t) and parse_duration(t)
    ):
        seconds = parse_duration(t)
        if not seconds:
            return VoiceResult("timer_ask", "¿De cuántos minutos? Digan, por ejemplo: temporizador de diez minutos.")
        label_m = re.search(r"\bpara ((?:el |la |los |las )?.+)$", o)
        said = label_m.group(1).strip() if label_m else ""
        said = re.sub(r"\s*\b(en |de )?(\d+|[a-záéíóúñ]+) (horas?|minutos?|segundos?)\b.*$", "", said).strip()
        label = re.sub(r"^(el|la|los|las) ", "", said)
        return VoiceResult(
            "timer_set", f"Listo, temporizador de {_say_duration(seconds)}{f' para {said}' if said else ''}.",
            data={"seconds": seconds, "label": _nice(label) if label else "", "said": said},
        )

    # ------------------------------------------------ modo cocina
    if screen == "cook":
        if re.search(r"^(siguiente|sigue|el siguiente|proximo|continua|continuar|y ahora|despues|listo sigue|ya siguiente)\b", t):
            return VoiceResult("step_next", "")
        if re.search(r"^(anterior|atras|el anterior|antes|devuelvete|regresa)\b", t):
            return VoiceResult("step_prev", "")
        if re.search(r"\b(repite|repitelo|otra vez|de nuevo|en que paso|que paso|que decia)\b", t):
            return VoiceResult("step_repeat", "")
        if re.search(r"^(ya )?(termine|terminamos|acabe|acabamos)( de cocinar)?$", t):
            return VoiceResult("cook_done", "")
        if ctx.get("recipe_id"):
            res = _recipe_question(session, t, ctx)
            if res:
                return res

    # ------------------------------------------------ se acabó
    m = re.search(r"^(?:ya )?(?:se (?:acabo|acabaron|termino|terminaron|gasto|gastaron)|no (?:hay|queda|quedan|tenemos) (?:mas )?|ya no (?:hay|queda|quedan|tenemos) (?:mas )?)(?:el |la |los |las |de )?(.+)$", t)
    if m:
        return _ran_out(session, _split_items(orig(m)))

    # ------------------------------------------------ quitar de la lista
    m = re.search(r"^(?:quita|quitar|quiten|borra|borrar|borren|saca|sacar|tacha|tachar|elimina)\s+(?:el |la |los |las )?(.+?)\s+de la lista(?: de (?:compras|mercado))?$", t)
    if not m:
        m = re.search(r"^ya (?:compre|compramos|compraron|traje|trajimos)\s+(?:el |la |los |las )?(.+)$", t)
    if m:
        items = _split_items(orig(m))
        if items:
            return _list_remove(session, items)

    # ------------------------------------------------ agregar a la lista
    m = re.search(r"^(?:agrega|agregar|agreguen|agregue|anota|anotar|anoten|anote|apunta|apuntar|apunten|anade|anadir|pon|ponga|pongan|hay que comprar|necesitamos|necesito|toca comprar|compra|comprar|compren|falta|faltan)\s+(.+)$", t)
    if m and not (t.startswith(("pon ", "ponga", "pongan")) and "lista" not in t):
        items = _split_items(orig(m))
        if items:
            return _add_to_list(session, items)

    # ------------------------------------------------ preguntas
    if re.search(r"\bque (se )?(vence|vencen|venza|venzan|va a vencer|van a vencer|esta por vencer|estan por vencer|se va a danar|se dana|se dane)\b", t):
        return _expiring(session, today)
    if re.search(r"\b(que (falta|hay que|toca) comprar|que necesitamos( comprar)?|que (hay|tenemos) en la lista|que dice la lista|lista de (compras|mercado))\b", t):
        res = _shopping_summary(session, today)
        if re.search(r"\b(abre|abrir|muestra|ver|ir a)\b", t) or t in {"lista de compras", "lista de mercado"}:
            res.navigate = {"screen": "shopping"}
        return res
    if re.search(r"\b(que (tareas|me toca|nos toca|le toca|hay que hacer|falta hacer|falta por hacer)|tareas de hoy|a quien le toca|pendientes)\b", t):
        return _chores_summary(session, today)
    if re.search(r"\bque (cocino|cocinamos|puedo cocinar|podemos cocinar|preparo|preparamos|hago de (comer|almuerzo|cena|desayuno|merienda)|hacemos de (comer|almuerzo|cena|desayuno|merienda))\b|\bideas? (para|de) (comer|cocinar|almuerzo|cena)", t):
        return _what_to_cook(session, t)
    if re.search(r"\bque (hay|vamos a comer|comemos|almorzamos|cenamos|desayunamos|toca) (manana|pasado manana|el (" + "|".join(WEEKDAY_KEYS) + r"))\b", t):
        return _menu_day(session, t, today)
    if re.search(r"\b(que (hay|vamos a comer|comemos|toca|hay para|se come|hacemos) (de|para|hoy|al)|que hay (de|para) (comer|almuerzo|cena|desayuno|merienda)|menu de hoy|que vamos a (almorzar|cenar|desayunar)|que almorzamos|que cenamos)\b", t):
        return _menu_day(session, t, today)

    # ------------------------------------------------ tareas hechas
    chore_res = _chore_done(session, t, today)
    if chore_res:
        return chore_res

    # ------------------------------------------------ abrir receta
    m = re.search(r"^(?:abre|abrir|abreme|muestra|muestrame|mostrar|ver|busca|buscar|como se hace|como hago|como se prepara|como preparo|quiero (?:hacer|cocinar|preparar)|vamos a (?:hacer|cocinar|preparar)|cocinemos|hagamos|receta)\s+(?:la receta de |la receta del |receta de |el |la |los |las |un |una )?(.+)$", t)
    if m:
        res = _open_recipe(session, m.group(1))
        if res:
            return res

    # ------------------------------------------------ navegar
    if re.fullmatch(r"(ve al |ir al |volver al |vuelve al |regresa al )?(inicio|principio|pantalla principal|home)|volver|vuelve|regresa|atras", t):
        return VoiceResult("navigate", "", navigate={"screen": "home"})
    if re.search(r"\b(escanear|escanea|leer|lee) (la |una )?factura\b|^factura$", t):
        return VoiceResult("navigate", "Abro para escanear la factura.", navigate={"screen": "receipt"})
    m = re.search(r"\b(escanear|escanea|foto( a| de)?|tomale una foto a|revisa|revisar|mira|mirar|reconoce) (a )?(la |el )?(nevera|alacena|despensa|refri|refrigerador|congelador)\b", t)
    if m:
        place = "alacena" if m.group(5) in ("alacena", "despensa") else "nevera"
        return VoiceResult("navigate", f"Abro para tomarle foto a la {place}.", navigate={"screen": "fridge", "place": place})
    if re.search(r"^(abre |ver |muestra )?(la )?lista( de compras| de mercado)?$", t):
        return VoiceResult("navigate", "", navigate={"screen": "shopping"})
    if re.search(r"^(abre |ver |muestra )?(las )?(tareas|oficios)$", t):
        return VoiceResult("navigate", "", navigate={"screen": "chores"})
    if re.search(r"^(abre |ver |muestra )?(las )?fotos$", t):
        return VoiceResult("navigate", "", navigate={"screen": "photos"})
    if re.search(r"\b(arma|armar|armemos|armen|hacer|hagamos|planea|planear|planeemos) (el )?menu\b", t):
        return VoiceResult("navigate", "Abro el asistente para armar el menú de la semana.", navigate={"screen": "sunday"})
    if re.search(r"^(abre |ver |muestra |muestrame )?(el )?menu( de la semana| semanal)?$", t):
        return VoiceResult("navigate", "", navigate={"screen": "menu"})
    if re.search(r"^(abre |ver |muestra |muestrame )?(el )?inventario$|^(revisar|revisemos|vamos a revisar) (la casa|la nevera y la alacena|que hay)$", t):
        return VoiceResult("navigate", "", navigate={"screen": "inventory"})
    if re.search(r"^(abre |ver |muestra |muestrame )?(los )?(logros|premios)( de los ninos)?$|\bcuantas estrellas\b|\bestrellas (de|tiene|lleva)\b", t):
        if re.search(r"\bcuantas estrellas\b|\bestrellas (de|tiene|lleva)\b", t):
            return _stars(session, t, today)
        return VoiceResult("navigate", "", navigate={"screen": "stars"})
    if re.search(r"^(abre |ver |muestra )?(la )?(que cocino)$", t):
        return VoiceResult("navigate", "", navigate={"screen": "what"})

    # ------------------------------------------------ ¿hay leche? ¿cuánto arroz queda?
    m = re.search(r"^(?:todavia |aun )?(?:hay|tenemos|queda|quedan|nos queda|nos quedan)\s+(?!que\b)(.+)$", t) \
        or re.search(r"^cuant[oa]s? (.+?) (?:hay|queda|quedan|tenemos|nos queda|nos quedan)(?: en la casa| en la nevera)?$", t)
    if m:
        return _pantry_query(session, orig(m))
    return None


def _agenda_add(session: Session, o: str, t: str, today: dt.date, ctx: dict) -> VoiceResult | None:
    explicit = re.match(r"^(recuerd|recordar|acuerdame|agenda)", t) or re.search(r"\b(agenda|calendario)\b", t)
    if "lista" in t and not re.search(r"\b(agenda|calendario)\b", t):
        return None  # «agrega pan a la lista para mañana» es de la lista de compras
    members = list(session.exec(select(Member)))
    data = agenda.parse_phrase(o, t, today, members, partial=True)
    if data and data["day"] is None and not explicit:
        return None  # «pon música» no es para la agenda
    if (data is None or data["day"] is None) and explicit and not ctx.get("handsfree"):
        try:
            smart = agenda.parse_with_ai(o, today, members, ai.model_for(session, "text"))
        except ai.AIError:
            smart = None
        if smart and (data is None or not data["title"] or smart["day"]):
            data = {**(data or {}), **smart, "all_day": (data or {}).get("all_day", False)}
    if data is None or not data.get("title"):
        if explicit:
            return VoiceResult("agenda_ask", "¿Qué les recuerdo? Digan, por ejemplo: recuérdame llamar a la abuela el jueves a las 3.")
        return None
    return _agenda_next(session, data, today, members)


# Recordatorio a medias: viaja a la tablet y vuelve con la respuesta («¿para qué día?» → «el jueves»).
def _draft(data: dict) -> dict:
    return {
        "kind": "agenda", "title": data["title"], "category": data["category"], "member_id": data["member_id"],
        "day": data["day"].isoformat() if isinstance(data["day"], dt.date) else data["day"],
        "time": data["time"], "repeat": data["repeat"], "all_day": data.get("all_day", False),
        "tries": data.get("tries", 0),
    }


def _agenda_next(session: Session, data: dict, today: dt.date, members: list) -> VoiceResult:
    """Pregunta lo que falte (primero el día, luego la hora) o, si ya está todo, lo anota."""
    title = data["title"]
    if not data["day"]:
        return VoiceResult("agenda_ask", f"¿Para qué día es «{title}»?",
                           data={"pending": {**_draft(data), "need": "day"}})
    needs_time = not data["time"] and not data.get("all_day") and data["category"] != "cumpleaños"
    if needs_time:
        return VoiceResult("agenda_ask", "¿A qué hora? O digan «todo el día» o «a cualquier hora».",
                           data={"pending": {**_draft(data), "need": "time"}})
    day = data["day"] if isinstance(data["day"], dt.date) else dt.date.fromisoformat(data["day"])
    event = Event(
        title=title, category=data["category"], member_id=data["member_id"], day=day,
        time=data["time"], repeat=data["repeat"], remind=",".join(map(str, agenda.remind_for(data["category"], data["time"]))),
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    if gcal.enabled(session):
        gcal.sync_soon(session.get_bind(), force=True)
    who = next((m.name for m in members if m.id == event.member_id), None)
    who = f" de {who}" if who and who.lower() not in event.title.lower() else ""
    when = agenda.day_text(event.day, today) + (f" {agenda.say_hour(event.time)}" if event.time else "")
    rep_txt = {"weekly": ", cada semana", "monthly": ", cada mes", "yearly": ", cada año"}.get(event.repeat, "")
    remind = agenda.remind_for(event.category, event.time)
    notice = " Les aviso el día antes y dos horas antes." if remind == [1440, 120] else {
        1440: " Les aviso el día antes.", 60: " Les aviso una hora antes.", 0: " Les aviso ese día."}.get(remind[0], "")
    return VoiceResult(
        "agenda_add", f"Listo, anoté {event.title}{who} para {when}{rep_txt}.{notice}",
        undo={"steps": [{"method": "DELETE", "url": f"/api/events/{event.id}"}], "speak": "Listo, lo quité de la agenda."},
        data={"event_id": event.id, "title": event.title, "date": event.day.isoformat(), "time": event.time},
    )


CANCEL = r"^(no|nada|cancela|cancelar|cancelalo|olvidalo|olvida|dejalo|deja asi|ya no|mejor no|no importa)\b"


def _agenda_answer(session: Session, o: str, t: str, today: dt.date, pending: dict) -> VoiceResult | None:
    """La respuesta a «¿para qué día?» o «¿a qué hora?». None si parece otro comando."""
    if re.search(CANCEL, t) and not re.search(agenda.ALL_DAY, t):
        return VoiceResult("agenda_cancel", "Listo, no lo anoto.")
    members = list(session.exec(select(Member)))
    got = agenda.parse_phrase(o, t, today, members, partial=True) or {}
    data = {**pending}
    data["day"] = dt.date.fromisoformat(pending["day"]) if pending.get("day") else None
    need = pending.get("need")
    if got.get("day"):
        data["day"] = got["day"]
    if got.get("time"):
        data["time"] = got["time"]
    if got.get("all_day"):
        data["all_day"] = True
    if got.get("repeat", "none") != "none":
        data["repeat"] = got["repeat"]
    understood = (need == "day" and data["day"]) or (need == "time" and (data["time"] or data.get("all_day")))
    if not understood:
        if re.match(agenda.TRIGGER, t) or len(t.split()) > 6:
            return None  # dijeron otra cosa: se atiende como un comando nuevo
        tries = pending.get("tries", 0) + 1
        if tries >= 2:
            return VoiceResult("agenda_cancel", "No les entendí, así que no lo anoté. Pueden decirlo de nuevo con el día y la hora.")
        ask = ("¿Para qué día? Por ejemplo: mañana, el jueves o el 15." if need == "day"
               else "¿A qué hora? Por ejemplo: a las 3 de la tarde. O digan «todo el día» o «a cualquier hora».")
        return VoiceResult("agenda_ask", f"No entendí. {ask}", data={"pending": {**pending, "tries": tries}})
    data["tries"] = 0
    return _agenda_next(session, data, today, members)




def _say_duration(seconds: int) -> str:
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if h:
        parts.append(f"{h} hora{'s' if h > 1 else ''}")
    if m:
        parts.append(f"{m} minuto{'s' if m > 1 else ''}")
    if s:
        parts.append(f"{s} segundo{'s' if s > 1 else ''}")
    return " y ".join(parts)


# ---------------------------------------------------------------- acciones


def _find_ingredient(session: Session, name: str) -> Ingredient | None:
    key = services.ingredient_key(name)
    ing = session.exec(select(Ingredient).where(Ingredient.key == key)).first()
    if ing:
        return ing
    best, score = None, 0.0
    for cand in session.exec(select(Ingredient)):
        s = _match_score(name, cand.name)
        if s > score:
            best, score = cand, s
    return best if score >= 0.99 else None


def _ran_out(session: Session, items: list[str]) -> VoiceResult:
    names, undo = [], []
    for raw in items:
        ing = _find_ingredient(session, raw)
        name = ing.name if ing else _nice(raw)
        if ing:
            item = session.exec(select(PantryItem).where(PantryItem.ingredient_id == ing.id)).first()
            if item:
                undo.append({"method": "PATCH", "url": f"/api/pantry/{item.id}", "json": {"quantity": item.quantity}})
                item.quantity = 0
        extra = _ensure_extra(session, name)
        if extra:
            undo.append({"method": "DELETE", "url": f"/api/shopping/extra/{extra.id}"})
        names.append(name)
    session.commit()
    return VoiceResult(
        "ran_out", f"Anotado en la lista: {_list([n.lower() for n in names])}.",
        undo={"steps": undo, "speak": "Listo, lo quité de la lista."}, data={"items": names},
    )


def _ensure_extra(session: Session, name: str) -> ShoppingExtra | None:
    """Anota en la lista si no estaba; devuelve el registro nuevo (None si ya estaba)."""
    key = services.ingredient_key(name)
    for e in session.exec(select(ShoppingExtra)):
        if services.ingredient_key(e.name) == key:
            return None
    extra = ShoppingExtra(name=_nice(name))
    session.add(extra)
    session.flush()
    return extra


def _add_to_list(session: Session, items: list[str]) -> VoiceResult:
    names, undo = [], []
    for raw in items:
        ing = _find_ingredient(session, raw)
        name = ing.name if ing else _nice(raw)
        extra = _ensure_extra(session, name)
        if extra:
            undo.append({"method": "DELETE", "url": f"/api/shopping/extra/{extra.id}"})
        names.append(name)
    session.commit()
    return VoiceResult(
        "list_add", f"Listo, agregué {_list([n.lower() for n in names])} a la lista.",
        undo={"steps": undo, "speak": "Listo, lo quité de la lista."}, data={"items": names},
    )


def _chore_done(session: Session, t: str, today: dt.date) -> VoiceResult | None:
    done_verbs = r"(ya |acabo de |acabamos de )?(hice|hicimos|termine|terminamos|saque|sacamos|saco|lave|lavamos|lavo|regue|regamos|rego|cambie|cambiamos|cambio|limpie|limpiamos|limpio|barri|barrimos|barrio|tendi|tendimos|tendio|pasee|paseamos|paseo|organice|organizamos|ordene|ordenamos|bote|botamos|arregle|arreglamos|recogi|recogimos|doble|doblamos|planche|planchamos)\b"
    said_done = re.search(done_verbs, t) or re.search(r"\b(esta|estan|quedo|quedaron) (lista|listo|listas|listos|hecha|hecho|hechas|hechos)\b", t)
    if not said_done:
        return None
    chores = session.exec(select(Chore)).all()
    best, score = None, 0.0
    for c in chores:
        s = _match_score(t, c.name)
        if s > score:
            best, score = c, s
    if not best or score < 0.34:
        return None
    members = session.exec(select(Member)).all()
    who = next((m for m in members if re.search(rf"\b{re.escape(normalize(m.name))}\b", t)), None)
    household.complete_chore(session, best, who.id if who else None, today)
    session.commit()
    thanks = f"¡Gracias, {who.name}!" if who else "¡Gracias!"
    return VoiceResult(
        "chore_done", f"{thanks} Marqué «{best.name}» como hecha.",
        undo={"steps": [{"method": "POST", "url": f"/api/chores/{best.id}/undo"}], "speak": "Listo, la tarea quedó pendiente otra vez."},
        data={"chore_id": best.id, "chore": best.name},
    )


def _what_to_cook(session: Session, t: str) -> VoiceResult:
    meal = next((m for m in MEALS if m in t), None)
    sugg = services.suggest(session, meal_type=meal, limit=3)
    if not sugg:
        return VoiceResult("what", "Todavía no hay recetas guardadas para eso.", navigate={"screen": "what", "meal": meal})
    names = [s["recipe"]["name"].lower() for s in sugg]
    ready = [s["recipe"]["name"].lower() for s in sugg if s["can_cook"]]
    tail = f" Con lo que hay se puede hacer {_list(ready)}." if ready else ""
    return VoiceResult("what", f"Les sugiero {_list(names)}.{tail}", navigate={"screen": "what", "meal": meal})


def _open_recipe(session: Session, query: str) -> VoiceResult | None:
    best, score = None, 0.0
    for r in session.exec(select(Recipe)):
        s = _match_score(query, r.name)
        if s > score:
            best, score = r, s
    if not best or score < 0.5:
        return None
    return VoiceResult(
        "open_recipe", f"Abro la receta de {best.name.lower()}.",
        navigate={"screen": "cook", "recipeId": best.id}, data={"recipe_id": best.id},
    )


def _recipe_question(session: Session, t: str, ctx: dict) -> VoiceResult | None:
    recipe = session.get(Recipe, int(ctx["recipe_id"]))
    if not recipe:
        return None
    servings = ctx.get("servings") or recipe.servings
    kids = int(ctx.get("kids") or 0)
    eaten = services.portions(session, int(servings), kids) if ctx.get("servings") else servings
    lines = services.scaled_ingredients(recipe, eaten)
    if re.search(r"\b(ingredientes|que lleva|que necesito|que necesitamos)\b", t) and not re.search(r"\bcuant", t):
        said = [f"{_amount(i)} {i['name'].lower()}".strip() for i in lines]
        who = f"{servings} adultos y {kids} niño{'s' if kids > 1 else ''}" if kids else f"{servings} personas"
        return VoiceResult("ingredients", f"Para {who} lleva: {_list(said)}.")
    m = re.search(r"\bcuant[oa]s?\s+(?:de\s+)?(.+?)(?:\s+(?:lleva|necesito|necesita|le echo|le pongo|va|van|se usa|hay que))?$", t)
    if not m:
        return None
    target = m.group(1)
    best, score = None, 0.0
    for i in lines:
        s = _match_score(target, i["name"])
        if s > score:
            best, score = i, s
    if not best or score < 0.5:
        return VoiceResult("ingredient_qty", f"La receta no lleva {target}.")
    return VoiceResult("ingredient_qty", f"Lleva {_amount(best)} de {best['name'].lower()}.".replace("  ", " "))


def _amount(i: dict) -> str:
    q = i["quantity"]
    if not q:
        return "al gusto"
    unit = i["unit"]
    q_txt = f"{q:g}".replace(".", ",")
    frac = {0.5: "media", 0.25: "un cuarto de", 0.75: "tres cuartos de"}
    if q in frac and unit not in ("g", "ml"):
        return f"{frac[q]} {unit}"
    plural = unit if q == 1 or unit in ("g", "kg", "ml", "l", "cda", "cdta") else (unit + "s" if unit[-1] in "aeiou" else unit + "es")
    names = {"g": "gramos", "kg": "kilos", "ml": "mililitros", "l": "litros", "cda": "cucharadas", "cdta": "cucharaditas"}
    if unit in names:
        plural = names[unit] if q != 1 else names[unit][:-1]
    return f"{q_txt} {plural}"


def _expiring(session: Session, today: dt.date) -> VoiceResult:
    items = household.today_summary(session, today)["expiring"]
    if not items:
        return VoiceResult("expiring", "Nada está por vencerse.")
    said = []
    for e in items:
        d = e["days_left"]
        when = "ya se venció" if d < 0 else "vence hoy" if d == 0 else "vence mañana" if d == 1 else f"vence en {d} días"
        said.append(f"{e['name'].lower()} {when}")
    return VoiceResult("expiring", _nice(_list(said)) + ".")


def _shopping_summary(session: Session, today: dt.date) -> VoiceResult:
    start = today - dt.timedelta(days=today.weekday())
    items = household.full_shopping_list(session, start, start + dt.timedelta(days=6))
    if not items:
        return VoiceResult("shopping", "No falta nada por comprar.")
    names = [i["name"].lower() for i in items[:6]]
    more = f" y {len(items) - 6} cosas más" if len(items) > 6 else ""
    return VoiceResult("shopping", f"Faltan {len(items)} cosas: {', '.join(names)}{more}.")


def _chores_summary(session: Session, today: dt.date) -> VoiceResult:
    chores = [c for c in household.list_chores(session, today) if c["is_due"] and not c["done_today"]]
    if not chores:
        return VoiceResult("chores", "No hay tareas pendientes por hoy.")
    said = []
    for c in chores[:5]:
        who = f", le toca a {c['turn']['name']}" if c.get("turn") else ""
        said.append(f"{c['name'].lower()}{who}")
    return VoiceResult("chores", f"Pendientes: {'; '.join(said)}.")


# ---------------------------------------------------------------- comida: menú, sobras y lo que hay

WEEKDAY_KEYS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
MEAL_PATTERNS = [
    ("desayuno", r"desayun\w*"),
    ("almuerzo", r"almuerz\w*|almorz\w*"),
    ("merienda", r"merienda\w*|merend\w*|onces"),
    ("cena", r"cena|cenar|cenamos|ceno|comida de la noche"),
]
PLACE_WORDS = r"(?:en |a |para )?(?:la |el )?(nevera|refri|refrigerador|congelador|congeladora|freezer)"
PORTION_WORDS = r"(\d+(?:[.,]\d+)?|media|[a-z]+) (?:porciones|porcion|platos?|raciones?|tarros?|coquitas?|recipientes?)"


def _cut(o: str, t: str, spans: list[tuple[int, int]]) -> tuple[str, str]:
    """Quita tramos de la frase (en las dos versiones, que tienen las mismas posiciones)."""
    for a, b in sorted(spans, reverse=True):
        o, t = o[:a] + " " + o[b:], t[:a] + " " + t[b:]
    clean = lambda s: re.sub(r"\s+", " ", s).strip(" ,")  # noqa: E731
    return clean(o), clean(t)


def _day_in(t: str, today: dt.date) -> tuple[dt.date | None, tuple[int, int] | None]:
    """El día que se nombra: hoy, mañana, pasado mañana, el jueves (el próximo, o hoy si es jueves)."""
    m = re.search(r"\b(pasado manana|(?<!la )(?<!por la )manana|hoy|(?:el |este |el proximo )?(" + "|".join(WEEKDAY_KEYS) + r"))\b", t)
    if not m:
        return None, None
    word = m.group(1)
    if word == "hoy":
        day = today
    elif word == "pasado manana":
        day = today + dt.timedelta(days=2)
    elif word.endswith("manana"):
        day = today + dt.timedelta(days=1)
    else:
        day = agenda._next_weekday(today, WEEKDAY_KEYS.index(m.group(2)), strict=False)
    return day, (m.start(), m.end())


def _meal_in(t: str) -> tuple[str | None, tuple[int, int] | None]:
    for meal, pat in MEAL_PATTERNS:
        m = re.search(rf"\b(?:de |del |para el |para la |en el |en la |al |a la |la |el )?(?:{pat})\b", t)
        if m:
            return meal, (m.start(), m.end())
    return None, None


def _meal_now() -> str:
    hour = clock.now().hour
    return "desayuno" if hour < 10 else "almuerzo" if hour < 16 else "cena"


def _clean_food(name: str) -> str:
    name = re.sub(r"^(?:y |con |de |del |las |los |la |el |unas |unos |un |una |sobras? (?:de |del )?)+", "", name.strip())
    name = re.sub(r"^sobras?$", "", name)  # «hoy almorzamos sobras»: no dijeron cuáles
    name = re.sub(r"\s+(?:de hoy|de ayer|que sobro|que sobraron|que quedo|que quedaron|al menu|en el menu)$", "", name)
    return name.strip(" ,")


def _best_recipe(session: Session, query: str, threshold: float = 0.5) -> Recipe | None:
    best, score = None, 0.0
    for r in session.exec(select(Recipe).where(Recipe.disliked == False)):  # noqa: E712
        s = _match_score(query, r.name)
        if s > score:
            best, score = r, s
    return best if best and score >= threshold else None


def _find_leftover(session: Session, name: str) -> Leftover | None:
    rows = list(session.exec(select(Leftover).where(Leftover.portions > 0)))
    key = services.ingredient_key(name)
    for x in rows:
        if services.ingredient_key(x.name) == key:
            return x
    best, score = None, 0.0
    for x in rows:
        s = max(_match_score(name, x.name), _match_score(x.name, name))
        if s > score:
            best, score = x, s
    return best if best and score >= 0.5 else None


def _portions_say(n: float) -> str:
    n = round(n, 1)
    txt = f"{n:g}".replace(".", ",")
    return f"{txt} porción" if n == 1 else f"{txt} porciones"


def _place_say(place: str) -> str:
    return "en la nevera" if place == "nevera" else "en el congelador"


def _leftovers_summary(session: Session, today: dt.date) -> VoiceResult:
    rows = leftovers.available(session, today)
    if not rows:
        return VoiceResult("leftovers", "No hay sobras anotadas. Cuando guarden algo, digan por ejemplo: guardé frijoles en el congelador.")
    said = []
    for x in rows:
        old = f", de hace {x['days']} días" if x["place"] == "nevera" and x["days"] >= 2 else ""
        said.append(f"{x['name'].lower()}, {_portions_say(x['portions'])} {_place_say(x['place'])}{old}")
    return VoiceResult("leftovers", f"Hay sobras de {_list(said)}.", data={"leftovers": rows})


def _leftover_save(session: Session, o: str, t: str, today: dt.date) -> VoiceResult | None:
    """«Guardé frijoles en el congelador», «sobraron 3 porciones de lasaña», «guardé sobras de pizza de ayer»."""
    spans = []
    place = "nevera"
    m = re.search(r"\b" + PLACE_WORDS + r"\b", t)
    if m:
        place = "congelador" if m.group(1).startswith(("congel", "freez")) else "nevera"
        spans.append((m.start(), m.end()))
    portions = None
    m = re.search(r"\b" + PORTION_WORDS + r"\b", t) or re.search(r"\bpara (\d+|[a-z]+) (?:personas|comidas|adultos)\b", t)
    if m:
        portions = 0.5 if m.group(1) == "media" else _num(m.group(1))
        if portions:
            spans.append((m.start(), m.end()))
    made_on = today - dt.timedelta(days=1) if re.search(r"\bde ayer\b", t) else today
    o2, t2 = _cut(o, t, spans)
    verb = re.match(r"^(?:ya )?(?:guarde|guardamos|guardo|guardaron|meti|metimos|puse|pusimos|sobro|sobraron|quedo|quedaron|anota|anote|anoten|apunta|apunten)\s+", t2)
    name = _clean_food(o2[verb.end():] if verb else o2)
    name = re.sub(r"\s+(?:de ayer|de hoy)$", "", name).strip()
    if not name or len(name) > 60:
        return None
    if portions is None:
        portions = services.portions(session)
    recipe = _best_recipe(session, name, threshold=0.99)
    left = Leftover(name=_nice(name), portions=portions, place=place, made_on=made_on,
                    recipe_id=recipe.id if recipe else None)
    session.add(left)
    session.commit()
    session.refresh(left)
    return VoiceResult(
        "leftover_add", f"Listo, anoté sobras de {left.name.lower()} {_place_say(place)}: {_portions_say(portions)}.",
        undo={"steps": [{"method": "DELETE", "url": f"/api/leftovers/{left.id}"}], "speak": "Listo, quité esas sobras."},
        data={"leftover_id": left.id, "name": left.name},
    )


def _leftover_eat(session: Session, left: Leftover, today: dt.date, portions: float | None) -> VoiceResult:
    plate = session.exec(select(MenuLeftover).where(
        MenuLeftover.leftover_id == left.id, MenuLeftover.eaten == False, MenuLeftover.day <= today,  # noqa: E712
    ).order_by(MenuLeftover.day.desc())).first()
    if plate and portions is None:
        leftovers.eat(session, plate)
        undo = [{"method": "POST", "url": f"/api/menu/leftovers/{plate.id}/uneat"}]
    else:
        undo = [{"method": "PATCH", "url": f"/api/leftovers/{left.id}", "json": {"portions": left.portions}}]
        left.portions = max(0.0, round(left.portions - (portions or services.portions(session)), 2))
        session.add(left)
    session.commit()
    rest = f"Quedan {_portions_say(left.portions)}." if left.portions > 0 else f"Se acabaron las sobras de {left.name.lower()}."
    return VoiceResult("leftover_eat", f"¡Buen provecho! {rest}",
                       undo={"steps": undo, "speak": "Listo, siguen guardadas."}, data={"leftover_id": left.id})


def _pick_leftover(session: Session, name: str) -> tuple[Leftover | None, VoiceResult | None]:
    """Las sobras que nombran; si no nombran ninguna y hay una sola, esa. Si no, se pregunta."""
    if name:
        left = _find_leftover(session, name)
        if left:
            return left, None
        return None, VoiceResult("leftover_unknown", f"No tengo anotadas sobras de {name}.")
    rows = list(session.exec(select(Leftover).where(Leftover.portions > 0)))
    if len(rows) == 1:
        return rows[0], None
    if not rows:
        return None, VoiceResult("leftover_unknown", "No hay sobras anotadas.")
    return None, VoiceResult("leftover_unknown", f"¿Cuáles sobras? Hay de {_list([x.name.lower() for x in rows])}.")


def _menu_add(session: Session, o: str, t: str, today: dt.date) -> VoiceResult | None:
    """«Hoy almorzamos sobras de bolognesa», «pon lentejas el jueves de almuerzo»,
    «mañana cenamos arroz con pollo con sobras de frijoles»."""
    day, dspan = _day_in(t, today)
    meal, mspan = _meal_in(t)
    o2, t2 = _cut(o, t, [s for s in (dspan, mspan) if s])
    t2 = re.sub(r"^(?:vamos a |van a |va a )?(?:pon|ponme|pongan|ponga|agrega|agregar|agreguen|anota|programa|comemos|comer|almorzamos|cenamos|desayunamos)\s+", "", t2)
    o2 = o2[len(o2) - len(t2):] if len(o2) >= len(t2) else t2
    if meal is None:
        if not re.search(r"\b(comemos|comer)\b", t):
            return None
        meal = _meal_now()
    day = day or today
    main, side = t2, ""
    m = re.search(r"\s+con (?:las |unas )?sobras?(?: de| del)?\s*(.*)$", t2)
    if m:
        main, side = t2[:m.start()], m.group(1) or "*"
    main_o, side_o = o2[:len(main)], (o2[len(o2) - len(side):] if side and side != "*" else "")
    main_o = re.sub(r"\s+(?:al|en el) menu$", "", main_o).strip()
    only_left = bool(re.match(r"^(?:las |unas |de )?sobras?\b", main.strip()))
    diners = services.meal_diners(session, meal)
    added, undo = [], []

    def add_left(name: str) -> VoiceResult | None:
        left, problem = _pick_leftover(session, _clean_food(name))
        if problem:
            return problem
        plate = MenuLeftover(day=day, meal_type=meal, leftover_id=left.id, portions=services.portions(session, *diners))
        session.add(plate)
        session.flush()
        added.append(f"sobras de {left.name.lower()}")
        undo.append({"method": "DELETE", "url": f"/api/menu/leftovers/{plate.id}"})
        return None

    if only_left:
        if (problem := add_left(main_o)) is not None:
            return problem
    else:
        name = _clean_food(main_o)
        recipe = _best_recipe(session, name) if name else None
        left = None if recipe else (_find_leftover(session, name) if name else None)
        if recipe:
            entry = MenuEntry(day=day, meal_type=meal, recipe_id=recipe.id, servings=diners[0], kids=diners[1])
            session.add(entry)
            session.flush()
            added.append(recipe.name.lower())
            undo.append({"method": "DELETE", "url": f"/api/menu/{entry.id}"})
        elif left:
            if (problem := add_left(left.name)) is not None:
                return problem
        else:
            if not re.search(r"\bmenu\b", t):
                return None  # no era para el menú
            return VoiceResult("menu_unknown", f"No encontré la receta {name}. Se agregan en Ajustes → Recetas.")
    if side and (problem := add_left("" if side == "*" else side_o)) is not None:
        session.rollback()
        return problem
    session.commit()
    when = agenda.day_text(day, today)
    return VoiceResult(
        "menu_add", f"Listo, {when} de {meal}: {' con '.join(added)}.",
        undo={"steps": undo, "speak": "Listo, lo quité del menú."}, data={"day": day.isoformat(), "meal": meal},
    )


def _menu_day(session: Session, t: str, today: dt.date) -> VoiceResult:
    """«¿Qué hay de almuerzo?», «¿qué comemos mañana?», «¿qué hay de cena el jueves?»."""
    day, _ = _day_in(t, today)
    day = day or today
    meal = next((m for m in MEALS if m in t or (m == "almuerzo" and "almorz" in t) or (m == "cena" and "cenar" in t) or (m == "desayuno" and "desayun" in t)), None)
    when = agenda.day_text(day, today)
    pantry = services.load_pantry(session)
    parts = []
    entries = session.exec(select(MenuEntry).where(MenuEntry.day == day)).all()
    plates = leftovers.plates(session, day, day)
    for m in sorted({e.meal_type for e in entries} | {p.meal_type for p in plates}, key=lambda x: services.MEAL_ORDER.get(x, 9)):
        if meal and m != meal:
            continue
        dishes = []
        for e in [e for e in entries if e.meal_type == m]:
            line = e.recipe.name.lower()
            if not e.cooked:
                avail = services.check_availability(e.recipe, services.entry_portions(session, e), pantry)
                missing = [i["name"].lower() for i in avail["items"] if i["status"] in ("falta", "poco") and not i["optional"]]
                if missing:
                    line += f" (falta {_list(missing)})"
            dishes.append(line)
        dishes += [f"sobras de {p.leftover.name.lower()}" + (" (ya se comieron)" if p.eaten else "")
                   for p in plates if p.meal_type == m]
        parts.append(f"de {m}, {' con '.join(dishes)}")
    if not parts:
        return VoiceResult("menu_today", f"No hay nada planeado{f' de {meal}' if meal else ''} para {when}. Pueden decir: qué cocino.")
    return VoiceResult("menu_today", f"{_nice(when)} hay " + ". ".join(parts) + ".")


def _pantry_query(session: Session, name: str) -> VoiceResult | None:
    """«¿Hay leche?», «¿cuánto arroz queda?». None si no suena a algo de la casa."""
    name = _clean_food(re.sub(r"^(?:mas |todavia |aun )", "", name))
    if not name or len(name.split()) > 4 or re.search(r"\b(algo|nada|alguien|que|como|donde)\b", strip_accents(name)):
        return None
    ing = _find_ingredient(session, name)
    item = session.exec(select(PantryItem).where(PantryItem.ingredient_id == ing.id)).first() if ing else None
    left = _find_leftover(session, name)
    extra = f" Y hay sobras de {left.name.lower()}: {_portions_say(left.portions)} {_place_say(left.place)}." if left else ""
    if item and item.quantity > 0:
        qty = _amount({"quantity": round(item.quantity, 2), "unit": item.unit})
        low = " Queda poco." if item.min_quantity is not None and item.quantity < item.min_quantity else ""
        return VoiceResult("pantry_query", f"Sí, hay {qty} de {ing.name.lower()}.{low}{extra}")
    if left:
        return VoiceResult("pantry_query", extra.strip())
    what = ing.name.lower() if ing else name
    return VoiceResult("pantry_query", f"No hay {what} anotado en la casa. Si hace falta, digan: agrega {what} a la lista.")


def _list_remove(session: Session, items: list[str]) -> VoiceResult:
    removed, undo, missing = [], [], []
    extras = list(session.exec(select(ShoppingExtra)))
    for raw in items:
        key = services.ingredient_key(raw)
        hit = next((e for e in extras if services.ingredient_key(e.name) == key), None) or next(
            (e for e in extras if _match_score(raw, e.name) >= 0.99), None)
        if hit:
            removed.append(hit.name.lower())
            undo.append({"method": "POST", "url": "/api/shopping/extra", "json": {"name": hit.name}})
            session.delete(hit)
            extras.remove(hit)
        else:
            missing.append(raw)
    session.commit()
    if not removed:
        return VoiceResult("list_remove", f"{_nice(_list(missing))} no estaba anotado a mano en la lista. Lo que sale del menú se quita solo al guardar la factura.")
    tail = f" {_nice(_list(missing))} no estaba anotado a mano." if missing else ""
    return VoiceResult("list_remove", f"Listo, quité {_list(removed)} de la lista.{tail}",
                       undo={"steps": undo, "speak": "Listo, lo volví a anotar."}, data={"items": removed})


def _stars(session: Session, t: str, today: dt.date) -> VoiceResult:
    kids = rewards.kids(session)
    if not kids:
        return VoiceResult("stars", "No hay niños anotados en la casa.")
    named = [k for k in kids if re.search(rf"\b{re.escape(normalize(k.name))}\b", t)]
    said = []
    for k in named or kids:
        s = rewards.summary(session, k, today)
        line = f"{k.name} lleva {s['stars']} estrella{'s' if s['stars'] != 1 else ''}"
        goal = s["goal"]
        if goal:
            left = goal["stars"] - s["stars"]
            line += f"; ya puede reclamar {goal['name'].lower()}" if left <= 0 else f"; le faltan {left} para {goal['name'].lower()}"
        said.append(line)
    return VoiceResult("stars", ". ".join(said) + ".", navigate=None)


def _food_rules(session: Session, o: str, t: str, today: dt.date) -> VoiceResult | None:
    # ¿Qué sobras hay?
    if re.search(r"\b(que|cuales) sobras\b|\b(hay|tenemos|quedan) sobras\b|^sobras$|\b(abre|ver|muestra|muestrame|mira) (las )?sobras\b", t):
        res = _leftovers_summary(session, today)
        if re.search(r"\b(abre|ver|muestra|muestrame|mira)\b", t) or t == "sobras":
            res.navigate = {"screen": "leftovers"}
        return res
    # Se acabaron / se botaron las sobras de X
    m = re.search(r"^(?:ya )?(?:se (?:acabaron|acabo|terminaron|termino|botaron|boto|danaron|dano)|bota|bote|botamos|tira|tire|tiramos) (?:las |unas )?sobras? (?:de |del )?(.+)$", t)
    if m:
        left, problem = _pick_leftover(session, _clean_food(o[m.start(1):m.end(1)]))
        if problem:
            return problem
        before = left.portions
        leftovers.finish(session, left)
        session.commit()
        return VoiceResult("leftover_done", f"Listo, se acabaron las sobras de {left.name.lower()}.",
                           undo={"steps": [{"method": "PATCH", "url": f"/api/leftovers/{left.id}", "json": {"portions": before}}],
                                 "speak": "Listo, siguen guardadas."})
    # Nos comimos las sobras de X
    m = re.search(r"^(?:ya )?(?:nos comimos|comimos|se comieron|me comi|ya almorzamos|ya cenamos)\s+(.+)$", t)
    if m:
        rest = o[m.start(1):m.end(1)]
        portions = None
        pm = re.search(r"\b" + PORTION_WORDS + r"\b", t[m.start(1):])
        if pm:
            portions = 0.5 if pm.group(1) == "media" else _num(pm.group(1))
            rest = rest[:pm.start()] + rest[pm.end():]
        said_left = bool(re.search(r"\bsobras?\b", t))
        name = _clean_food(re.sub(r"^(?:de |del )", "", rest.strip()))
        left = _find_leftover(session, name) if name else None
        if left is None and said_left:
            left, problem = _pick_leftover(session, name)
            if problem:
                return problem
        if left:
            return _leftover_eat(session, left, today, portions)
    # Guardé sobras
    if re.search(r"^(?:ya )?(?:guarde|guardamos|guardo|guardaron|meti|metimos|anota|anote|anoten|apunta|apunten|quedaron|quedo|sobraron|sobro)\s+(?:unas |las |los )?sobras?\b", t) \
            or re.search(r"^(?:ya )?(?:sobro|sobraron)\s+", t) \
            or re.search(r"^(?:quedo|quedaron)\s+" + PORTION_WORDS, t) \
            or (re.search(r"^(?:ya )?(?:guarde|guardamos|meti|metimos|puse|pusimos)\s+.+\s" + PLACE_WORDS + r"\b", t)):
        res = _leftover_save(session, o, t, today)
        if res:
            return res
    # Poner algo en el menú (va antes de la agenda: «pon lentejas el jueves» es del menú)
    if re.search(r"^(?:hoy |manana |pasado manana |el \w+ |este \w+ )?(?:vamos a |van a )?(?:almorzamos|cenamos|desayunamos|comemos|almorzar|cenar|desayunar|comer)\s+\S", t) \
            or (re.search(r"^(?:pon|ponme|pongan|ponga|agrega|agregar|agreguen|anota|programa)\s+", t)
                and (re.search(r"\bmenu\b", t) or _meal_in(t)[0]) and "lista" not in t and not parse_duration(t)):
        res = _menu_add(session, o, t, today)
        if res:
            return res
    return None


# ---------------------------------------------------------------- IA (opcional)


def _ai_canonical(session: Session, text: str, context: dict) -> str | None:
    """Pide a la IA de texto reescribir la frase como un comando conocido. None si no hay clave o falla."""
    from . import vision  # importación tardía: el SDK solo se usa si hace falta

    recipes = [r.name for r in session.exec(select(Recipe))]
    chores = [c.name for c in session.exec(select(Chore))]
    lefts = [x.name for x in session.exec(select(Leftover).where(Leftover.portions > 0))]
    try:
        return vision.voice_canonical(
            text, recipes, chores, context.get("screen") or "home", model=ai.model_for(session, "text"),
            leftovers=lefts,
        )
    except vision.VisionError:
        return None

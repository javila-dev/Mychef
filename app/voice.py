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

from . import agenda, ai, clock, gcal, household, services
from .models import Chore, Event, Ingredient, Member, PantryItem, Recipe, ShoppingExtra
from .units import strip_accents

MEALS = ["desayuno", "almuerzo", "merienda", "cena"]

HELP = (
    "Pueden decir, por ejemplo: se acabó la leche; agrega pan a la lista; ya saqué la basura; "
    "¿qué hay de almuerzo?; ¿qué cocino?; abre la receta de lentejas; "
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

    # ------------------------------------------------ agregar a la lista
    m = re.search(r"^(?:agrega|agregar|agreguen|agregue|anota|anotar|anoten|anote|apunta|apuntar|apunten|anade|anadir|pon|ponga|pongan|hay que comprar|necesitamos|necesito|toca comprar|compra|comprar|compren|falta|faltan)\s+(.+)$", t)
    if m and not (t.startswith(("pon ", "ponga", "pongan")) and "lista" not in t):
        items = _split_items(orig(m))
        if items:
            return _add_to_list(session, items)

    # ------------------------------------------------ preguntas
    if re.search(r"\bque (se )?(vence|vencen|va a vencer|van a vencer|esta por vencer|estan por vencer|se va a danar|se dana)\b", t):
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
    if re.search(r"\b(que (hay|vamos a comer|comemos|toca|hay para|se come|hacemos) (de|para|hoy|al)|que hay (de|para) (comer|almuerzo|cena|desayuno|merienda)|menu de hoy|que vamos a (almorzar|cenar|desayunar)|que almorzamos|que cenamos)\b", t):
        return _menu_today(session, t, today)

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


def _menu_today(session: Session, t: str, today: dt.date) -> VoiceResult:
    summary = household.today_summary(session, today)
    meal = next((m for m in MEALS if m in t or (m == "almuerzo" and "almorz" in t) or (m == "cena" and "cenar" in t) or (m == "desayuno" and "desayun" in t)), None)
    meals = [m for m in summary["meals"] if not meal or m["meal_type"] == meal]
    if not meals:
        return VoiceResult("menu_today", f"No hay nada planeado{f' de {meal}' if meal else ' para hoy'}. Pueden decir: qué cocino.")
    parts = []
    for m in meals:
        line = f"de {m['meal_type']}, {m['recipe']['name'].lower()}"
        if not m["cooked"] and m["missing"]:
            line += f"; falta {_list([x.lower() for x in m['missing']])}"
        parts.append(line)
    return VoiceResult("menu_today", "Hoy hay " + ". ".join(parts) + ".", data={"meals": meals})


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


# ---------------------------------------------------------------- IA (opcional)


def _ai_canonical(session: Session, text: str, context: dict) -> str | None:
    """Pide a la IA de texto reescribir la frase como un comando conocido. None si no hay clave o falla."""
    from . import vision  # importación tardía: el SDK solo se usa si hace falta

    recipes = [r.name for r in session.exec(select(Recipe))]
    chores = [c.name for c in session.exec(select(Chore))]
    try:
        return vision.voice_canonical(
            text, recipes, chores, context.get("screen") or "home", model=ai.model_for(session, "text")
        )
    except vision.VisionError:
        return None

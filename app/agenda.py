"""La agenda de la familia: citas médicas, cosas del colegio, cumpleaños, pagos…

Cada evento tiene día, hora opcional, para quién es, si se repite y cuándo avisar en voz alta.
La tablet pregunta cada minuto (/api/reminders) y aquí se calcula qué avisos caen hoy.
"""

from __future__ import annotations

import calendar
import datetime as dt
import re

from pydantic import BaseModel
from sqlmodel import Session, select

from . import clock
from .household import MONTHS, WEEKDAYS
from .models import EVENT_CATEGORIES, Event, Member
from .units import strip_accents

CATEGORY_LABEL = {
    "salud": "Salud", "colegio": "Colegio", "cumpleaños": "Cumpleaños",
    "pagos": "Pagos", "familia": "Familia", "otro": "Otro",
}
REMIND_CHOICES = {0: "A la hora", 60: "1 hora antes", 120: "2 horas antes", 1440: "El día antes"}
ALL_DAY_TIME = dt.time(7, 30)      # a qué hora se avisa lo que no tiene hora
DAY_BEFORE_TIME = dt.time(19, 30)  # «mañana es la reunión…» se avisa la noche anterior


# ---------------------------------------------------------------- fechas


def _add_months(day: dt.date, months: int, want_day: int) -> dt.date:
    month = day.month - 1 + months
    year, month = day.year + month // 12, month % 12 + 1
    return dt.date(year, month, min(want_day, calendar.monthrange(year, month)[1]))


def occurrences(event: Event, start: dt.date, end: dt.date) -> list[dt.date]:
    """Los días en que cae el evento entre start y end (incluidos)."""
    if event.repeat == "none":
        return [event.day] if start <= event.day <= end else []
    out: list[dt.date] = []
    if event.repeat == "weekly":
        d = event.day
        if d < start:
            d += dt.timedelta(days=((start - d).days + 6) // 7 * 7)
        while d <= end:
            out.append(d)
            d += dt.timedelta(days=7)
        return out
    step = 12 if event.repeat == "yearly" else 1
    n = 0
    if event.day < start:
        n = max(0, ((start.year - event.day.year) * 12 + start.month - event.day.month) // step - 1)
    while True:
        d = _add_months(event.day, n * step, event.day.day)
        if d > end:
            return out
        if d >= start:
            out.append(d)
        n += 1


def remind_list(event: Event) -> list[int]:
    return sorted({int(x) for x in (event.remind or "").split(",") if x.strip().isdigit()}, reverse=True)


def _at(day: dt.date, time: str | None) -> dt.datetime:
    t = dt.time.fromisoformat(time) if time else ALL_DAY_TIME
    return dt.datetime.combine(day, t)


def alert_time(day: dt.date, time: str | None, minutes: int) -> dt.datetime:
    """Cuándo sonar para un evento del día `day`, `minutes` antes."""
    if minutes >= 1440 and (not time or minutes % 1440 == 0):
        return dt.datetime.combine(day - dt.timedelta(days=minutes // 1440), DAY_BEFORE_TIME)
    return _at(day, time) - dt.timedelta(minutes=minutes)


# ---------------------------------------------------------------- en palabras


def fmt_hour(time: str) -> str:
    """«15:30» → «3:30 p. m.» (para leer en pantalla)."""
    h, m = map(int, time.split(":"))
    return f"{h % 12 or 12}:{m:02d} {'a. m.' if h < 12 else 'p. m.'}"


def say_hour(time: str) -> str:
    """«15:30» → «a las 3 y media de la tarde» (para decir en voz alta)."""
    h, m = map(int, time.split(":"))
    if h == 12 and m == 0:
        return "al mediodía"
    h12 = h % 12 or 12
    mins = {0: "", 15: " y cuarto", 30: " y media", 45: " y cuarenta y cinco"}.get(m, f" y {m}")
    part = "de la mañana" if h < 12 else "de la tarde" if h < 19 else "de la noche"
    return f"{'a la' if h12 == 1 else 'a las'} {h12}{mins} {part}"


def day_text(day: dt.date, today: dt.date) -> str:
    diff = (day - today).days
    if diff == 0:
        return "hoy"
    if diff == 1:
        return "mañana"
    if diff == 2:
        return "pasado mañana"
    if 0 < diff < 7:
        return f"el {WEEKDAYS[day.weekday()]}"
    return f"el {WEEKDAYS[day.weekday()]} {day.day} de {MONTHS[day.month - 1]}"


def _title_with_member(event: Event, member: Member | None) -> str:
    if member and strip_accents(member.name.lower()) not in strip_accents(event.title.lower()):
        return f"{event.title} ({member.name})"
    return event.title


# ---------------------------------------------------------------- listas


def event_out(event: Event, day: dt.date, members: dict[int, Member], today: dt.date) -> dict:
    m = members.get(event.member_id) if event.member_id else None
    return {
        "id": event.id,
        "title": event.title,
        "category": event.category,
        "category_label": CATEGORY_LABEL.get(event.category, "Otro"),
        "member": {"id": m.id, "name": m.name} if m else None,
        "member_id": event.member_id,
        "date": day.isoformat(),
        "first_day": event.day.isoformat(),
        "time": event.time,
        "time_text": fmt_hour(event.time) if event.time else "Todo el día",
        "day_text": day_text(day, today),
        "notes": event.notes,
        "repeat": event.repeat,
        "remind": remind_list(event),
        "done": event.done_on is not None,
    }


def upcoming(session: Session, days: int = 30, today: dt.date | None = None, include_done: bool = False) -> list[dict]:
    today = today or clock.today()
    end = today + dt.timedelta(days=days)
    members = {m.id: m for m in session.exec(select(Member))}
    out = []
    for e in session.exec(select(Event)):
        if e.done_on and not include_done:
            continue
        # lo que no se repite y ya pasó sin marcarse sigue apareciendo hasta 3 días (por si se olvidó)
        start = today - dt.timedelta(days=3) if e.repeat == "none" and not e.done_on else today
        for d in occurrences(e, start, end):
            out.append(event_out(e, d, members, today))
    out.sort(key=lambda x: (x["date"], x["time"] or "00:00", x["title"]))
    return out


def alerts(session: Session, now: dt.datetime | None = None) -> list[dict]:
    """Los avisos en voz alta que caen hoy (la tablet decide si ya es la hora)."""
    now = now or clock.now()
    today = now.date()
    members = {m.id: m for m in session.exec(select(Member))}
    out = []
    for e in session.exec(select(Event)):
        if e.done_on:
            continue
        for d in occurrences(e, today, today + dt.timedelta(days=8)):
            for minutes in remind_list(e):
                at = alert_time(d, e.time, minutes)
                if at.date() != today:
                    continue
                m = members.get(e.member_id) if e.member_id else None
                when = day_text(d, today)
                if e.time:
                    when = "ahora" if minutes == 0 else f"{when} {say_hour(e.time)}"
                out.append({
                    **event_out(e, d, members, today),
                    "kind": "event",
                    "id": f"e{e.id}-{d.isoformat()}-{minutes}",
                    "event_id": e.id,
                    "remind_at": at.strftime("%H:%M"),
                    "say": f"Recordatorio: {when}, {_title_with_member(e, m).replace(' (', ' de ').rstrip(')')}.",
                })
    return out


def summary(session: Session, today: dt.date | None = None, days: int = 7) -> str:
    """La agenda de los próximos días, para decirla en voz alta."""
    today = today or clock.today()
    items = upcoming(session, days, today)
    if not items:
        return "No hay nada en la agenda para los próximos días."
    parts = []
    for x in items[:6]:
        hour = f" {say_hour(x['time'])}" if x["time"] else ""
        who = f" de {x['member']['name']}" if x["member"] and x["member"]["name"].lower() not in x["title"].lower() else ""
        parts.append(f"{x['day_text']}{hour}: {x['title']}{who}")
    more = f" Y {len(items) - 6} cosas más." if len(items) > 6 else ""
    return (". ".join(p[:1].upper() + p[1:] for p in parts)) + "." + more


# ---------------------------------------------------------------- entender una frase

MONTH_KEYS = [strip_accents(m) for m in MONTHS]
DAY_KEYS = [strip_accents(d) for d in WEEKDAYS]
NUMBERS = {
    "un": 1, "una": 1, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7,
    "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15,
    "dieciseis": 16, "diecisiete": 17, "dieciocho": 18, "diecinueve": 19, "veinte": 20, "veintiuno": 21,
    "veintidos": 22, "veintitres": 23, "veinticuatro": 24, "veinticinco": 25, "veintiseis": 26,
    "veintisiete": 27, "veintiocho": 28, "veintinueve": 29, "treinta": 30, "treinta y uno": 31,
    "primero": 1,
}
NUM = r"(\d{1,2}|" + "|".join(sorted(NUMBERS, key=len, reverse=True)) + ")"
CATEGORY_WORDS = [
    ("salud", r"\b(cita|medic|doctor|doctora|odontolog|dentista|pediatra|vacuna|control|terapia|examen(es)? de sangre|laboratorio|eps|clinica|hospital|oftalmolog|optometr)"),
    ("colegio", r"\b(colegio|escuela|jardin|tarea|tareas|profe|profesora?|reunion de padres|entrega de notas|uniforme|excursion|izada|exposicion|clase|examen|evaluacion)"),
    ("cumpleaños", r"\b(cumpleanos|cumple)\b"),
    ("pagos", r"\b(pagar|pago|pagos|factura|arriendo|administracion|recibo|luz|agua|gas|internet|tarjeta|cuota|colegiatura|pension|mensualidad|impuesto|soat)\b"),
]
TRIGGER = r"^(?:recuerdame|recuerdanos|recuerdenme|recuerdales|recordarme|recordar|acuerdame|anota|anotar|anoten|apunta|apunten|agenda|agendar|agendame|agrega|agregar|pon|ponme|programa)(?: en la agenda| a la agenda| en el calendario)?(?: que| de| el| la)?\s+"


def _n(word: str) -> int | None:
    return int(word) if word.isdigit() else NUMBERS.get(word)


def _next_weekday(today: dt.date, wd: int, strict: bool) -> dt.date:
    ahead = (wd - today.weekday()) % 7
    if ahead == 0 and strict:
        ahead = 7
    return today + dt.timedelta(days=ahead)


def parse_phrase(o: str, t: str, today: dt.date, members: list[Member]) -> dict | None:
    """Entiende frases como «recuérdame la cita de Benja con la pediatra el jueves a las 3».

    `o` es la frase con tildes y `t` la misma sin tildes (mismas posiciones). Devuelve los datos del
    evento o None si no encuentra el día (entonces se le pregunta a la IA).
    """
    spans: list[tuple[int, int]] = []

    def take(m: re.Match, group: int = 0) -> None:
        spans.append((m.start(group), m.end(group)))

    trig = re.match(TRIGGER, t)
    if trig:
        take(trig)

    # ---- hora (antes que la fecha: «de la mañana» no es «mañana»)
    time = None
    m = re.search(r"\b(?:a la|a las|al|tipo|como a las)\s+(mediodia|" + NUM[1:-1] + r")(?::(\d{2})| y (media|cuarto|\d{1,2}))?"
                  r"(?:\s+(?:de la (manana|tarde|noche)|en la (manana|tarde|noche)|(am|pm|a m|p m)))?\b", t)
    if m:
        if m.group(1) == "mediodia":
            h, mins = 12, 0
        else:
            h = _n(m.group(1)) or 0
            mins = int(m.group(2)) if m.group(2) else {"media": 30, "cuarto": 15}.get(m.group(3) or "", 0)
            if m.group(3) and m.group(3).isdigit():
                mins = int(m.group(3))
            period = m.group(4) or m.group(5) or (m.group(6) or "").replace(" ", "")
            if period in ("tarde", "noche", "pm") and h < 12:
                h += 12
            elif period in ("manana", "am") and h == 12:
                h = 0
            elif not period and 1 <= h <= 6:
                h += 12  # «a las 3» casi siempre es de la tarde
        if 0 <= h <= 23 and 0 <= mins <= 59:
            time = f"{h:02d}:{mins:02d}"
            take(m)

    # ---- repetición
    repeat = "none"
    m = re.search(r"\b(cada semana|todas las semanas|semanal(mente)?|cada mes|todos los meses|mensual(mente)?|cada ano|todos los anos|anual(mente)?)\b", t)
    if m:
        w = m.group(1)
        repeat = "weekly" if "seman" in w else "monthly" if ("mes" in w or "mensual" in w) else "yearly"
        take(m)

    # ---- día
    day = None
    m = re.search(r"\b(?:el |este |el proximo |el otro |para el |para este )?(" + "|".join(DAY_KEYS) + r")\b(?:\s+(" + NUM[1:-1] + r"))?(?: de (" + "|".join(MONTH_KEYS) + r"))?", t)
    m2 = re.search(r"\b(?:el |para el )?" + NUM + r" de (" + "|".join(MONTH_KEYS) + r")(?: de (\d{4}))?\b", t)
    if m2:
        dnum, month = _n(m2.group(1)), MONTH_KEYS.index(m2.group(2)) + 1
        year = int(m2.group(3)) if m2.group(3) else today.year
        try:
            day = dt.date(year, month, dnum)
            if not m2.group(3) and day < today:
                day = dt.date(year + 1, month, dnum)
            take(m2)
            if m and m.start() < m2.start() and m.end() >= m2.start() - 1:
                take(m)  # «el jueves 2 de octubre»
        except (TypeError, ValueError):
            day = None
    if day is None and m:
        wd = DAY_KEYS.index(m.group(1))
        if m.group(2):  # «el jueves 2»: ese número de día, en este mes o el siguiente
            dnum = _n(m.group(2)) or 0
            for k in range(0, 3):
                try:
                    cand = _add_months(today.replace(day=1), k, dnum)
                except ValueError:
                    continue
                if cand >= today and cand.day == dnum:
                    day = cand
                    break
        day = day or _next_weekday(today, wd, strict=True)
        if repeat == "none" and re.search(r"\btodos los " + m.group(1), t):
            repeat = "weekly"
        take(m)
    if day is None:
        m = re.search(r"\bpasado manana\b", t) or re.search(r"\bmanana\b", t) or re.search(r"\bhoy\b", t)
        if m:
            day = today + dt.timedelta(days=2 if m.group(0) == "pasado manana" else 1 if m.group(0) == "manana" else 0)
            take(m)
    if day is None:
        m = re.search(r"\b(?:dentro de|en) " + NUM + r" (dias|semanas?)\b", t)
        if m:
            n = _n(m.group(1)) or 0
            day = today + dt.timedelta(days=n * (7 if m.group(2).startswith("semana") else 1))
            take(m)
    if day is None:
        m = re.search(r"\b(?:el|para el) " + NUM + r"\b(?! (?:de la|minutos|horas))", t)
        if m and _n(m.group(1)) and 1 <= _n(m.group(1)) <= 31:
            dnum = _n(m.group(1))
            for k in range(0, 3):
                cand = _add_months(today.replace(day=1), k, dnum)
                if cand >= today and cand.day == dnum:
                    day = cand
                    break
            if day:
                take(m)
    if day is None:
        return None

    # ---- para quién
    member = None
    for mem in members:
        key = strip_accents(mem.name.lower())
        if re.search(r"\b" + re.escape(key) + r"\b", t):
            member = mem
            break

    # ---- categoría
    category = "familia"
    for cat, pattern in CATEGORY_WORDS:
        if re.search(pattern, t):
            category = cat
            break
    if category == "cumpleaños" and repeat == "none":
        repeat = "yearly"

    # ---- título: lo que queda de la frase
    keep = [True] * len(o)
    for a, b in spans:
        for i in range(a, min(b, len(o))):
            keep[i] = False
    title = "".join(ch if k else " " for ch, k in zip(o, keep))
    title = re.sub(r"\s+", " ", title).strip(" ,.")
    title = re.sub(r"^(que|de|el|la|los|las|hay|tengo|tenemos|tiene)\s+", "", title)
    title = re.sub(r"\s+(el|la|a|para|de|y|que)$", "", title).strip(" ,.")
    if not title:
        return None
    for mem in members:  # la voz llega en minúsculas: «benja» → «Benja»
        title = re.sub(r"\b" + re.escape(mem.name.lower()) + r"\b", mem.name, title)
    title = title[:1].upper() + title[1:]

    if time:
        remind = [1440, 120] if category == "salud" else [60]
    else:
        remind = [1440, 0] if category in ("colegio", "pagos") else [0]
    return {
        "title": title[:80], "category": category, "member_id": member.id if member else None,
        "day": day, "time": time, "repeat": repeat, "remind": remind,
    }


class EventDraft(BaseModel):
    ok: bool
    title: str
    category: str
    member: str | None
    date: str
    time: str | None
    repeat: str


def parse_with_ai(text: str, today: dt.date, members: list[Member], model: str) -> dict | None:
    """Si las reglas no entienden la frase, la IA de texto (OpenAI) la convierte en evento."""
    from . import ai

    names = ", ".join(m.name for m in members) or "(nadie registrado)"
    prompt = f"""Hoy es {WEEKDAYS[today.weekday()]} {today.isoformat()}. Alguien de la familia dijo: \
<frase>{text}</frase>
Si pide anotar algo en la agenda familiar (una cita, algo del colegio, un cumpleaños, un pago, un plan), \
devuelve ok = true y:
- title: corto y claro, en español, sin la fecha ni la hora (p. ej. "Cita con la pediatra").
- category: una de {", ".join(EVENT_CATEGORIES)}.
- member: para quién es, uno de: {names}; o null.
- date: AAAA-MM-DD (si dice un día de la semana, el próximo; nunca en el pasado).
- time: HH:MM en 24 horas, o null si no dice hora ("a las 3" sin más = 15:00).
- repeat: none, weekly, monthly o yearly (los cumpleaños son yearly).
Si no es algo para la agenda, ok = false y lo demás vacío."""
    draft = ai.openai_parse(model, prompt, EventDraft)
    if not draft.ok:
        return None
    try:
        day = dt.date.fromisoformat(draft.date)
    except ValueError:
        return None
    time = draft.time if draft.time and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", draft.time) else None
    member = next((m for m in members if m.name.lower() == (draft.member or "").lower()), None)
    category = draft.category if draft.category in EVENT_CATEGORIES else "familia"
    return {
        "title": draft.title.strip()[:80] or "Recordatorio", "category": category,
        "member_id": member.id if member else None, "day": day, "time": time,
        "repeat": draft.repeat if draft.repeat in ("none", "weekly", "monthly", "yearly") else "none",
        "remind": ([1440, 120] if category == "salud" else [60]) if time else [0],
    }

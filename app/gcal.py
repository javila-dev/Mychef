"""La agenda sincronizada con el calendario de Google que la familia ya comparte.

Se usa una «cuenta de servicio» de Google: no hay que iniciar sesión en la tablet. La familia
comparte su calendario con el correo de esa cuenta («Hacer cambios en los eventos») y listo:

    MYCHEF_GOOGLE_CREDENTIALS=/data/google.json   (el archivo JSON de la cuenta, o su contenido)

El calendario se elige en Ajustes. Desde ahí la sincronización va en los dos sentidos:
- lo que se anota en la tablet (o por voz) aparece en los celulares, y
- lo que se anota en el celular aparece en la tablet y se avisa en voz alta.

Qué se guarda dónde:
- En Google: título, día y hora, notas, si se repite. La categoría, la persona y los avisos van
  en propiedades privadas del evento (extendedProperties) para no perderlos.
- Solo aquí: «listo / ya pasó». Lo que viene de Google sin categoría se adivina por el título.

Lo que se repite de formas que la agenda no sabe (cada 2 semanas, lunes y miércoles…) se trae
como fechas sueltas; cambiar una de esas cambia solo esa vez.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import threading
import time

from sqlmodel import Session, select

from . import clock
from .models import EVENT_CATEGORIES, Event, Member, Setting, utcnow
from .units import strip_accents

SCOPES = ["https://www.googleapis.com/auth/calendar"]
API = "https://www.googleapis.com/calendar/v3"
PAST_DAYS = 30  # lo que ya pasó se trae hasta un mes atrás
AHEAD_DAYS = 400
AUTO_EVERY = 300  # segundos entre sincronizaciones automáticas
AUTO_SYNC = True  # las pruebas lo apagan

K_CALENDAR, K_LAST, K_ERROR, K_DELETED, K_BOUND = (
    "gcal_calendar_id", "gcal_last_sync", "gcal_error", "gcal_deleted", "gcal_bound")


class GCalError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class NotFound(GCalError):
    def __init__(self):
        super().__init__("No está en el calendario de Google.", 404)


# ---------------------------------------------------------------- la conexión con Google


def _credentials_info() -> dict | None:
    raw = (os.environ.get("MYCHEF_GOOGLE_CREDENTIALS") or "").strip()
    if not raw:
        return None
    try:
        if raw.startswith("{"):
            return json.loads(raw)
        with open(raw, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def service_email() -> str | None:
    info = _credentials_info()
    return info.get("client_email") if info else None


class GoogleCalendar:
    """Lo mínimo de la API de Google Calendar que usa la agenda."""

    def __init__(self, calendar_id: str, info: dict):
        from google.auth.transport.requests import AuthorizedSession
        from google.oauth2 import service_account

        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        self.http = AuthorizedSession(creds)
        self.base = f"{API}/calendars/{_quote(calendar_id)}"

    def _call(self, method: str, path: str, **kw) -> dict:
        try:
            r = self.http.request(method, self.base + path, timeout=20, **kw)
        except Exception as e:  # sin internet, la clave está mal…
            raise GCalError(f"No se pudo hablar con Google: {e}") from e
        if r.status_code in (404, 410):
            raise NotFound()
        if r.status_code == 403:
            raise GCalError("Google no deja usar ese calendario: compártanlo con el correo de la cuenta de servicio "
                            "con permiso de «Hacer cambios en los eventos».", 403)
        if r.status_code >= 400:
            try:
                msg = r.json()["error"]["message"]
            except (ValueError, KeyError, TypeError):
                msg = r.text[:200]
            raise GCalError(f"Google respondió: {msg}", 502 if r.status_code >= 500 else 400)
        return r.json() if r.content else {}

    def _pages(self, path: str, params: dict) -> list[dict]:
        out, token = [], None
        while True:
            data = self._call("GET", path, params={**params, **({"pageToken": token} if token else {})})
            out += data.get("items", [])
            token = data.get("nextPageToken")
            if not token:
                return out

    def info(self) -> dict:
        return self._call("GET", "")

    def list(self, time_min: str, time_max: str) -> list[dict]:
        return self._pages("/events", {"timeMin": time_min, "timeMax": time_max, "singleEvents": "false",
                                       "maxResults": 2500})

    def instances(self, event_id: str, time_min: str, time_max: str) -> list[dict]:
        return self._pages(f"/events/{_quote(event_id)}/instances",
                           {"timeMin": time_min, "timeMax": time_max, "maxResults": 2500})

    def insert(self, body: dict) -> dict:
        return self._call("POST", "/events", json=body)

    def patch(self, event_id: str, body: dict) -> dict:
        return self._call("PATCH", f"/events/{_quote(event_id)}", json=body)

    def delete(self, event_id: str) -> None:
        self._call("DELETE", f"/events/{_quote(event_id)}")


def _quote(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")


def client_for(calendar_id: str):
    """El cliente de Google (las pruebas lo cambian por uno de mentiras)."""
    info = _credentials_info()
    if not info:
        raise GCalError("Falta la cuenta de servicio de Google (MYCHEF_GOOGLE_CREDENTIALS).", 400)
    try:
        return GoogleCalendar(calendar_id, info)
    except ImportError as e:
        raise GCalError("Falta instalar google-auth (pip install -r requirements.txt).", 500) from e
    except ValueError as e:
        raise GCalError(f"El archivo de la cuenta de servicio no sirve: {e}", 400) from e


# ---------------------------------------------------------------- ajustes


def _get(session: Session, key: str) -> str:
    s = session.get(Setting, key)
    return s.value if s else ""


def _set(session: Session, key: str, value: str) -> None:
    session.merge(Setting(key=key, value=value))


def calendar_id(session: Session) -> str:
    return _get(session, K_CALENDAR) or os.environ.get("MYCHEF_GOOGLE_CALENDAR_ID", "").strip()


def enabled(session: Session) -> bool:
    return bool(calendar_id(session)) and _credentials_info() is not None


def status(session: Session) -> dict:
    return {
        "credentials": _credentials_info() is not None,
        "service_email": service_email(),
        "calendar_id": calendar_id(session),
        "calendar_name": _get(session, "gcal_calendar_name"),
        "enabled": enabled(session),
        # «+00:00Z» lo guardaba una versión anterior: el navegador no lo entiende
        "last_sync": _get(session, K_LAST).replace("+00:00Z", "Z") or None,
        "error": _get(session, K_ERROR) or None,
        "pending": len(_deleted(session)) + len(session.exec(
            select(Event.id).where(Event.sync_dirty == True)).all()),  # noqa: E712
    }


def connect(session: Session, cal_id: str) -> dict:
    """Guarda el calendario (después de probar que se puede usar) y sincroniza."""
    cal_id = cal_id.strip()
    info = client_for(cal_id).info()
    if _get(session, K_BOUND) and _get(session, K_BOUND) != cal_id:
        # Otro calendario: lo de aquí se sube al nuevo como si fuera nuevo.
        for e in session.exec(select(Event).where(Event.google_id != None)):  # noqa: E711
            e.google_id = e.google_series = e.google_updated = None
            e.sync_dirty = False
        _set(session, K_DELETED, "[]")
    _set(session, K_CALENDAR, cal_id)
    _set(session, K_BOUND, cal_id)
    _set(session, "gcal_calendar_name", info.get("summary", ""))
    session.commit()
    sync(session)
    return status(session)


def disconnect(session: Session) -> None:
    """Deja de sincronizar. Los eventos se quedan en la tablet y en Google."""
    _set(session, K_CALENDAR, "")
    _set(session, K_ERROR, "")
    session.commit()


def _deleted(session: Session) -> list[str]:
    try:
        return json.loads(_get(session, K_DELETED) or "[]")
    except ValueError:
        return []


def forget(session: Session, event: Event) -> None:
    """Se borró aquí: se borra en Google en la próxima sincronización."""
    if event.google_id:
        _set(session, K_DELETED, json.dumps(_deleted(session) + [event.google_id]))


def touched(event: Event) -> None:
    """Se cambió aquí: hay que subirlo."""
    if event.google_id:
        event.sync_dirty = True


# ---------------------------------------------------------------- de Google a la agenda

WD = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def _local(value: str) -> dt.datetime:
    d = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if d.tzinfo is None:
        return d
    return d.astimezone(clock.TZ).replace(tzinfo=None) if clock.TZ else d.astimezone().replace(tzinfo=None)


def _day_of(stamp: dict | None) -> dt.date | None:
    if not stamp:
        return None
    if stamp.get("date"):
        return dt.date.fromisoformat(stamp["date"])
    if stamp.get("dateTime"):
        return _local(stamp["dateTime"]).date()
    return None


def _ical_date(value: str) -> dt.date:
    """«20261231», «20261231T045959Z» o «20261231T160000» → la fecha en la casa."""
    value = value.strip()
    if "T" not in value:
        return dt.datetime.strptime(value[:8], "%Y%m%d").date()
    stamp = dt.datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    if value.endswith("Z"):
        return _local(stamp.replace(tzinfo=dt.timezone.utc).isoformat()).date()
    return stamp.date()


def parse_recurrence(lines: list[str], first: dt.date) -> dict | None:
    """La repetición de Google en palabras de la agenda, o None si la agenda no sabe repetirla así."""
    out = {"repeat": "none", "repeat_until": None, "skip": set()}
    rule = None
    for line in lines:
        name, _, value = line.partition(":")
        name = name.split(";")[0].upper()
        if name == "RRULE":
            if rule is not None:
                return None  # dos reglas
            rule = dict(p.split("=", 1) for p in value.split(";") if "=" in p)
        elif name == "EXDATE":
            out["skip"] |= {_ical_date(v) for v in value.split(",") if v.strip()}
        else:
            return None  # RDATE y otras rarezas
    if not rule:
        return None
    freq = rule.pop("FREQ", "")
    rule.pop("WKST", None)
    if rule.pop("INTERVAL", "1") != "1" or "COUNT" in rule:
        return None
    if "UNTIL" in rule:
        out["repeat_until"] = _ical_date(rule.pop("UNTIL"))
    if freq == "WEEKLY":
        if rule.pop("BYDAY", WD[first.weekday()]) != WD[first.weekday()]:
            return None
        out["repeat"] = "weekly"
    elif freq == "MONTHLY":
        if rule.pop("BYMONTHDAY", str(first.day)) != str(first.day):
            return None
        out["repeat"] = "monthly"
    elif freq == "YEARLY":
        if rule.pop("BYMONTH", str(first.month)) != str(first.month):
            return None
        if rule.pop("BYMONTHDAY", str(first.day)) != str(first.day):
            return None
        out["repeat"] = "yearly"
    else:
        return None  # todos los días, cada hora…
    return None if rule else out


def _clean_notes(text: str) -> str:
    text = re.sub(r"<br\s*/?>|</p>", "\n", text or "", flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return text.strip()[:300]


def guess_category(title: str) -> str:
    from .agenda import CATEGORY_WORDS

    t = strip_accents(title.lower())
    return next((cat for cat, rx in CATEGORY_WORDS if re.search(rx, t)), "familia")


def guess_member(title: str, members: list[Member]) -> int | None:
    t = strip_accents(title.lower())
    found = [m for m in members if re.search(r"\b" + re.escape(strip_accents(m.name.lower())) + r"\b", t)]
    return found[0].id if len(found) == 1 else None


def fields_from_google(item: dict) -> dict | None:
    """Los datos de un evento de Google en columnas de Event (sin categoría ni persona)."""
    start, end = item.get("start") or {}, item.get("end") or {}
    day = _day_of(start)
    if not day:
        return None
    f = {"title": ((item.get("summary") or "").strip() or "(Sin título)")[:80],
         "notes": _clean_notes(item.get("description", "")), "time": None, "end_time": None, "end_day": None}
    if start.get("dateTime"):
        a, b = _local(start["dateTime"]), _local(end["dateTime"]) if end.get("dateTime") else None
        f["time"] = a.strftime("%H:%M")
        if b and b > a:
            f["end_time"] = b.strftime("%H:%M")
            if b.date() > a.date() and not (b.date() == a.date() + dt.timedelta(days=1) and b.time() == dt.time()):
                f["end_day"] = b.date()
    elif end.get("date"):
        last = dt.date.fromisoformat(end["date"]) - dt.timedelta(days=1)  # en Google el fin no cuenta
        f["end_day"] = last if last > day else None
    f["day"] = day
    return f


def _ours(item: dict) -> dict:
    return (item.get("extendedProperties") or {}).get("private") or {}


# ---------------------------------------------------------------- de la agenda a Google


def _stamp(day: dt.date, time: str) -> dict:
    at = dt.datetime.combine(day, dt.time.fromisoformat(time))
    if clock.TZ:
        return {"dateTime": at.isoformat(timespec="seconds"), "timeZone": clock.TZ_NAME, "date": None}
    return {"dateTime": at.astimezone().isoformat(timespec="seconds"), "date": None}


def body_for(event: Event, member: Member | None) -> dict:
    body: dict = {
        "summary": event.title,
        "description": event.notes or "",
        "extendedProperties": {"private": {
            "mychef_category": event.category,
            "mychef_member": member.name if member else "",
            "mychef_remind": event.remind or "",
        }},
    }
    last = event.end_day if event.end_day and event.end_day > event.day else event.day
    if event.time:
        body["start"] = _stamp(event.day, event.time)
        if event.end_time and (last > event.day or event.end_time > event.time):
            body["end"] = _stamp(last, event.end_time)
        else:
            end = dt.datetime.combine(event.day, dt.time.fromisoformat(event.time)) + dt.timedelta(hours=1)
            body["end"] = _stamp(end.date(), end.strftime("%H:%M"))
    else:
        body["start"] = {"date": event.day.isoformat(), "dateTime": None}
        body["end"] = {"date": (last + dt.timedelta(days=1)).isoformat(), "dateTime": None}
    if not event.google_series:  # una vez suelta de una serie no lleva regla
        body["recurrence"] = rrule_for(event)
    return body


def rrule_for(event: Event) -> list[str]:
    if event.repeat == "none":
        return []
    rule = "RRULE:FREQ=" + {"weekly": "WEEKLY", "monthly": "MONTHLY", "yearly": "YEARLY"}[event.repeat]
    if event.repeat_until:
        rule += ";UNTIL=" + event.repeat_until.strftime("%Y%m%d") + ("T235959Z" if event.time else "")
    out = [rule]
    from .agenda import skipped

    for d in sorted(skipped(event)):
        if event.time:
            at = d.strftime("%Y%m%d") + "T" + event.time.replace(":", "") + "00"
            out.append(f"EXDATE;TZID={clock.TZ_NAME}:{at}" if clock.TZ else f"EXDATE:{at}")
        else:
            out.append(f"EXDATE;VALUE=DATE:{d.strftime('%Y%m%d')}")
    return out


# ---------------------------------------------------------------- sincronizar


def _rfc(day: dt.date) -> str:
    return dt.datetime.combine(day, dt.time(), dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sync(session: Session, client=None, today: dt.date | None = None) -> dict:
    """Sube lo cambiado aquí y trae lo de Google. Devuelve cuántos cambios hubo en cada sentido."""
    cal = calendar_id(session)
    if not cal:
        raise GCalError("No hay un calendario de Google conectado.", 400)
    today = today or clock.today()
    try:
        client = client or client_for(cal)
        up = _push(session, client, today)
        down = _pull(session, client, today)
    except Exception as e:
        session.rollback()
        _set(session, K_ERROR, str(e) if isinstance(e, GCalError) else f"Falló la sincronización: {e}")
        session.commit()
        raise
    _set(session, K_LAST, utcnow().replace(microsecond=0).isoformat().replace("+00:00", "Z"))
    _set(session, K_ERROR, "")
    session.commit()
    return {"up": up, "down": down}


def _push(session: Session, client, today: dt.date) -> int:
    n = 0
    gone = _deleted(session)
    for gid in list(gone):
        try:
            client.delete(gid)
        except NotFound:
            pass
        gone.remove(gid)
        _set(session, K_DELETED, json.dumps(gone))
        session.commit()
        n += 1
    members = {m.id: m for m in session.exec(select(Member))}
    since = today - dt.timedelta(days=PAST_DAYS)
    for e in session.exec(select(Event).where((Event.google_id == None) | (Event.sync_dirty == True))).all():  # noqa: E711,E712
        if not e.google_id and e.repeat == "none" and (e.end_day or e.day) < since:
            continue  # lo viejo que nunca se subió se queda aquí
        body = body_for(e, members.get(e.member_id))
        try:
            got = client.patch(e.google_id, body) if e.google_id else client.insert(body)
        except NotFound:
            session.delete(e)  # lo borraron en Google mientras se cambiaba aquí: gana el borrado
            session.commit()
            continue
        e.google_id, e.google_updated, e.sync_dirty = got["id"], got.get("updated"), False
        session.commit()
        n += 1
    return n


def _pull(session: Session, client, today: dt.date) -> int:
    since, until = today - dt.timedelta(days=PAST_DAYS), today + dt.timedelta(days=AHEAD_DAYS)
    tmin, tmax = _rfc(since), _rfc(until)
    items = client.list(tmin, tmax)

    masters = {i["id"]: i for i in items if not i.get("recurringEventId") and i.get("status") != "cancelled"}
    singles: list[tuple[dict, dict]] = []  # (evento, cambios en la repetición)
    skips: dict[str, set[dt.date]] = {}
    for i in items:
        series = i.get("recurringEventId")
        if not series:
            continue
        orig = _day_of(i.get("originalStartTime"))
        if orig:
            skips.setdefault(series, set()).add(orig)
        if i.get("status") != "cancelled":
            singles.append((i, {}))

    wanted: list[tuple[dict, dict]] = []
    for m in masters.values():
        if not m.get("recurrence"):
            wanted.append((m, {"repeat": "none", "repeat_until": None, "skip_days": ""}))
            continue
        rec = parse_recurrence(m["recurrence"], _day_of(m.get("start")) or today)
        if rec is None:
            # Se repite de una forma que la agenda no sabe: se traen las fechas una por una.
            for inst in client.instances(m["id"], tmin, tmax):
                if inst.get("status") != "cancelled":
                    wanted.append((inst, {"repeat": "none", "repeat_until": None, "skip_days": ""}))
            singles = [(i, x) for i, x in singles if i.get("recurringEventId") != m["id"]]
            continue
        skip = sorted(rec["skip"] | skips.get(m["id"], set()))
        wanted.append((m, {"repeat": rec["repeat"], "repeat_until": rec["repeat_until"],
                           "skip_days": ",".join(d.isoformat() for d in skip)}))
    wanted += [(i, {"repeat": "none", "repeat_until": None, "skip_days": ""})
               for i, _ in singles if i.get("recurringEventId") in masters]

    members = list(session.exec(select(Member)))
    by_name = {strip_accents(m.name.lower()): m.id for m in members}
    rows = {e.google_id: e for e in session.exec(select(Event).where(Event.google_id != None))}  # noqa: E711
    seen, n = set(), 0
    for item, rep in wanted:
        gid = item["id"]
        seen.add(gid)
        row = rows.get(gid)
        if row is not None and row.sync_dirty:
            continue  # lo de aquí gana: se sube en la próxima
        fields = fields_from_google(item)
        if not fields:
            continue
        fields.update(rep)
        fields["google_series"] = item.get("recurringEventId")
        mine = _ours(item)
        if row is not None and row.google_updated == item.get("updated") and row.skip_days == fields["skip_days"]:
            continue
        if row is None:
            row = Event(google_id=gid, **{k: v for k, v in fields.items()})
            session.add(row)
            old_title = None
        else:
            old_title = row.title
            for k, v in fields.items():
                setattr(row, k, v)
        if mine.get("mychef_category") in EVENT_CATEGORIES:
            row.category = mine["mychef_category"]
        elif old_title != row.title:
            row.category = guess_category(row.title)
        if "mychef_member" in mine:
            row.member_id = by_name.get(strip_accents(mine["mychef_member"].lower()))
        elif old_title != row.title:
            row.member_id = guess_member(row.title, members)
        if re.fullmatch(r"[\d,]*", mine.get("mychef_remind", "x")):
            row.remind = mine["mychef_remind"]
        elif old_title is None:
            from .agenda import remind_for

            row.remind = ",".join(map(str, remind_for(row.category, row.time)))
        row.google_updated = item.get("updated")
        n += 1

    # Lo que desapareció de Google (dentro de las fechas que se miraron) se borra aquí.
    for gid, row in rows.items():
        if gid in seen or row.sync_dirty:
            continue
        if row.repeat == "none" and (row.end_day or row.day) < since:
            continue  # ya es viejo: Google no lo devuelve, pero no se borró
        if row.day > until:
            continue
        session.delete(row)
        n += 1
    session.commit()
    return n


# ---------------------------------------------------------------- en segundo plano

_lock = threading.Lock()
_again = threading.Event()
_last_try = 0.0


def sync_soon(engine, force: bool = False) -> None:
    """Sincroniza en otro hilo: después de un cambio (force) o si hace rato que no se hace."""
    global _last_try
    if not AUTO_SYNC:
        return
    if not force and time.monotonic() - _last_try < AUTO_EVERY:
        return
    _last_try = time.monotonic()
    if _lock.locked():
        _again.set()  # la que está corriendo vuelve a pasar al terminar
        return
    threading.Thread(target=_run, args=(engine,), daemon=True).start()


def _run(engine) -> None:
    with _lock:
        while True:
            _again.clear()
            with Session(engine) as s:
                if enabled(s):
                    try:
                        sync(s)
                    except Exception:  # el error queda guardado en los ajustes
                        pass
            if not _again.is_set():
                return

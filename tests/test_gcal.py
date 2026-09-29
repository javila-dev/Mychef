import datetime as dt
import itertools
import re

import pytest
from sqlmodel import Session, select

from app import clock, gcal
from app.db import get_session
from app.main import app
from app.models import Event, Setting

TODAY = dt.date(2026, 9, 28)  # lunes


class FakeGoogle:
    """El calendario de Google, en memoria."""

    def __init__(self):
        self.events: dict[str, dict] = {}
        self.instances_of: dict[str, list[dict]] = {}
        self.ids = itertools.count(1)
        self.calls: list[tuple] = []

    def _stamp(self, item):
        item["updated"] = f"2026-09-28T10:00:{next(self.ids):02d}Z"
        return item

    def add(self, **item):
        item.setdefault("id", f"g{next(self.ids)}")
        item.setdefault("status", "confirmed")
        self.events[item["id"]] = self._stamp(item)
        return item

    def info(self):
        return {"summary": "Familia"}

    def list(self, time_min, time_max):
        return [dict(e) for e in self.events.values()]

    def instances(self, event_id, time_min, time_max):
        return self.instances_of.get(event_id, [])

    def insert(self, body):
        self.calls.append(("insert", body))
        return self.add(**{k: v for k, v in body.items()})

    def patch(self, event_id, body):
        self.calls.append(("patch", event_id, body))
        if event_id not in self.events:
            raise gcal.NotFound()
        self.events[event_id].update(body)
        return self._stamp(self.events[event_id])

    def delete(self, event_id):
        self.calls.append(("delete", event_id))
        if self.events.pop(event_id, None) is None:
            raise gcal.NotFound()


@pytest.fixture
def google(client, monkeypatch):
    fake = FakeGoogle()
    monkeypatch.setattr(gcal, "AUTO_SYNC", False)
    monkeypatch.setattr(gcal, "client_for", lambda cal: fake)
    monkeypatch.setattr(gcal, "_credentials_info", lambda: {"client_email": "mychef@proyecto.iam.gserviceaccount.com"})
    monkeypatch.setattr(clock, "today", lambda: TODAY)
    return fake


def session_of(client):
    return next(app.dependency_overrides[get_session]())


def sync(client):
    r = client.post("/api/gcal/sync")
    assert r.status_code == 200, r.text
    return r.json()


def test_parse_recurrence():
    tue = dt.date(2026, 9, 29)
    assert gcal.parse_recurrence(["RRULE:FREQ=WEEKLY;BYDAY=TU"], tue)["repeat"] == "weekly"
    r = gcal.parse_recurrence(["RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20261215T045959Z", "EXDATE;TZID=America/Bogota:20261006T160000"], tue)
    assert r["repeat_until"] == dt.date(2026, 12, 14) and r["skip"] == {dt.date(2026, 10, 6)}
    assert gcal.parse_recurrence(["RRULE:FREQ=YEARLY"], tue)["repeat"] == "yearly"
    assert gcal.parse_recurrence(["RRULE:FREQ=MONTHLY;BYMONTHDAY=29"], tue)["repeat"] == "monthly"
    # Lo que la agenda no sabe repetir
    assert gcal.parse_recurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"], tue) is None
    assert gcal.parse_recurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2"], tue) is None
    assert gcal.parse_recurrence(["RRULE:FREQ=DAILY"], tue) is None
    assert gcal.parse_recurrence(["RRULE:FREQ=WEEKLY;COUNT=4"], tue) is None


def test_fields_from_google_timezone_and_spans():
    f = gcal.fields_from_google({"summary": "Pediatra", "start": {"dateTime": "2026-10-01T20:00:00Z"},
                                 "end": {"dateTime": "2026-10-01T21:30:00Z"}, "description": "Llevar <b>carné</b>"})
    assert (f["day"], f["time"], f["end_time"], f["end_day"], f["notes"]) == (
        dt.date(2026, 10, 1), "15:00", "16:30", None, "Llevar carné")  # Bogotá es UTC-5
    f = gcal.fields_from_google({"summary": "Viaje a la finca", "start": {"date": "2026-10-10"}, "end": {"date": "2026-10-13"}})
    assert (f["day"], f["time"], f["end_day"]) == (dt.date(2026, 10, 10), None, dt.date(2026, 10, 12))
    f = gcal.fields_from_google({"summary": "Festivo", "start": {"date": "2026-10-12"}, "end": {"date": "2026-10-13"}})
    assert f["end_day"] is None


def test_connect_status(client, google):
    s = client.get("/api/gcal").json()
    assert s["credentials"] and not s["enabled"] and s["service_email"].startswith("mychef@")
    r = client.put("/api/gcal", json={"calendar_id": "familia@group.calendar.google.com"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["enabled"] and s["calendar_name"] == "Familia" and not s["error"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", s["last_sync"])  # el navegador lo entiende
    assert client.delete("/api/gcal").json()["enabled"] is False


def test_pull_from_google(client, google):
    client.post("/api/members", json={"name": "Benja"})
    google.add(summary="Cita de Benja con la pediatra", start={"dateTime": "2026-10-01T15:00:00-05:00"},
               end={"dateTime": "2026-10-01T16:00:00-05:00"})
    google.add(summary="Natación", start={"dateTime": "2026-09-29T16:00:00-05:00", "timeZone": "America/Bogota"},
               end={"dateTime": "2026-09-29T17:00:00-05:00"}, recurrence=["RRULE:FREQ=WEEKLY;BYDAY=TU"], id="nat")
    # Una vez cancelada y otra movida
    google.add(id="nat_20261006", recurringEventId="nat", status="cancelled",
               originalStartTime={"dateTime": "2026-10-06T16:00:00-05:00"})
    google.add(id="nat_20261013", recurringEventId="nat", summary="Natación (tarde)",
               originalStartTime={"dateTime": "2026-10-13T16:00:00-05:00"},
               start={"dateTime": "2026-10-13T18:00:00-05:00"}, end={"dateTime": "2026-10-13T19:00:00-05:00"})
    # Lunes y miércoles: la agenda no sabe, se trae fecha por fecha
    google.add(id="ing", summary="Inglés", start={"dateTime": "2026-09-28T17:00:00-05:00"},
               end={"dateTime": "2026-09-28T18:00:00-05:00"}, recurrence=["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"])
    google.instances_of["ing"] = [
        {"id": f"ing_{d}", "recurringEventId": "ing", "summary": "Inglés", "updated": "x",
         "start": {"dateTime": f"{d}T17:00:00-05:00"}, "end": {"dateTime": f"{d}T18:00:00-05:00"}}
        for d in ("2026-09-28", "2026-09-30", "2026-10-05")]

    client.put("/api/gcal", json={"calendar_id": "familia"})
    items = client.get("/api/events", params={"start": "2026-09-28", "end": "2026-10-15"}).json()
    got = [(e["date"], e["time"], e["title"]) for e in items]
    assert ("2026-10-01", "15:00", "Cita de Benja con la pediatra") in got
    assert [d for d, _, t in got if t == "Natación"] == ["2026-09-29"]  # la del 6 se canceló y la del 13 se movió
    assert ("2026-10-13", "18:00", "Natación (tarde)") in got
    assert [d for d, _, t in got if t == "Inglés"] == ["2026-09-28", "2026-09-30", "2026-10-05"]

    cita = next(e for e in items if e["title"].startswith("Cita"))
    assert cita["category"] == "salud" and cita["member"]["name"] == "Benja" and cita["google"]
    assert cita["remind"] == [1440, 120] and cita["time_text"] == "3:00 p. m. – 4:00 p. m."

    # Lo borran en el celular: desaparece de la tablet
    del google.events[next(k for k, v in google.events.items() if v.get("summary", "").startswith("Cita"))]
    sync(client)
    items = client.get("/api/events", params={"start": "2026-09-28", "end": "2026-10-15"}).json()
    assert not any(e["title"].startswith("Cita") for e in items)


def test_push_to_google(client, google):
    client.put("/api/gcal", json={"calendar_id": "familia"})
    mama = client.post("/api/members", json={"name": "Mamá"}).json()
    r = client.post("/api/events", json={"title": "Pagar la luz", "category": "pagos", "day": "2026-10-05",
                                          "repeat": "monthly", "remind": [1440, 0], "member_id": mama["id"]})
    ev = r.json()
    sync(client)
    body = next(c[1] for c in google.calls if c[0] == "insert")
    assert body["summary"] == "Pagar la luz" and body["recurrence"] == ["RRULE:FREQ=MONTHLY"]
    assert body["start"]["date"] == "2026-10-05" and body["end"]["date"] == "2026-10-06"
    assert body["extendedProperties"]["private"] == {
        "mychef_category": "pagos", "mychef_member": "Mamá", "mychef_remind": "0,1440"}

    # Se cambia en la tablet: se sube el cambio, con hora (y una hora de duración)
    client.put(f"/api/events/{ev['id']}", json={"title": "Pagar la luz", "category": "pagos", "day": "2026-10-05",
                                                 "time": "09:00", "repeat": "monthly", "remind": [60],
                                                 "member_id": mama["id"]})
    assert client.get("/api/gcal").json()["pending"] == 1
    sync(client)
    _, gid, body = next(c for c in google.calls if c[0] == "patch")
    assert body["start"] == {"dateTime": "2026-10-05T09:00:00", "timeZone": "America/Bogota", "date": None}
    assert body["end"]["dateTime"] == "2026-10-05T10:00:00"
    assert client.get("/api/gcal").json()["pending"] == 0

    # Lo que se sube vuelve igual (con sus propiedades) y no se duplica
    sync(client)
    items = client.get("/api/events", params={"start": "2026-10-01", "end": "2026-10-31"}).json()
    assert [(e["title"], e["member"]["name"], e["remind"]) for e in items] == [("Pagar la luz", "Mamá", [60])]

    # Se borra en la tablet: se borra en Google
    client.delete(f"/api/events/{ev['id']}")
    sync(client)
    assert ("delete", gid) in google.calls and gid not in google.events


def test_local_edit_wins_and_old_stays_local(client, google):
    s: Session = session_of(client)
    s.add(Event(title="Algo viejo", day=TODAY - dt.timedelta(days=90)))
    s.commit()
    client.put("/api/gcal", json={"calendar_id": "familia"})
    assert not any(c[0] == "insert" for c in google.calls)  # lo muy viejo no se sube

    g = google.add(summary="Reunión de padres", start={"date": "2026-10-02"}, end={"date": "2026-10-03"})
    sync(client)
    row = s.exec(select(Event).where(Event.google_id == g["id"])).one()
    assert row.category == "colegio"
    client.put(f"/api/events/{row.id}", json={"title": "Reunión de padres (virtual)", "category": "colegio",
                                               "day": "2026-10-02", "remind": [0]})
    google.events[g["id"]]["summary"] = "Reunión de padres (cambiada allá)"
    google._stamp(google.events[g["id"]])
    sync(client)
    assert google.events[g["id"]]["summary"] == "Reunión de padres (virtual)"


def test_change_calendar_uploads_again(client, google):
    client.put("/api/gcal", json={"calendar_id": "familia"})
    client.post("/api/events", json={"title": "Vacuna", "category": "salud", "day": "2026-10-09"})
    sync(client)
    s: Session = session_of(client)
    assert s.exec(select(Event)).one().google_id
    client.put("/api/gcal", json={"calendar_id": "otro"})
    assert sum(1 for c in google.calls if c[0] == "insert") == 2
    assert s.get(Setting, "gcal_bound").value == "otro"


def test_errors_are_saved(client, google, monkeypatch):
    client.put("/api/gcal", json={"calendar_id": "familia"})

    def broken(*a):
        raise gcal.GCalError("Google no deja usar ese calendario", 403)

    monkeypatch.setattr(google, "list", broken)
    r = client.post("/api/gcal/sync")
    assert r.status_code == 403
    assert client.get("/api/gcal").json()["error"] == "Google no deja usar ese calendario"


def test_body_for_multi_day_and_exdates():
    e = Event(title="Viaje", day=dt.date(2026, 10, 10), end_day=dt.date(2026, 10, 12))
    b = gcal.body_for(e, None)
    assert b["start"]["date"] == "2026-10-10" and b["end"]["date"] == "2026-10-13" and b["recurrence"] == []
    e = Event(title="Natación", day=dt.date(2026, 9, 29), time="16:00", repeat="weekly",
              skip_days="2026-10-06", repeat_until=dt.date(2026, 12, 15))
    assert gcal.rrule_for(e) == ["RRULE:FREQ=WEEKLY;UNTIL=20261215T235959Z",
                                 "EXDATE;TZID=America/Bogota:20261006T160000"]
    one = Event(title="Inglés", day=dt.date(2026, 9, 30), google_series="ing")
    assert "recurrence" not in gcal.body_for(one, None)


def test_range_endpoint_includes_spans(client):
    client.post("/api/events", json={"title": "Viaje", "day": "2026-09-26", "end_day": "2026-09-29"})
    items = client.get("/api/events", params={"start": "2026-09-28", "end": "2026-10-04"}).json()
    assert [(e["title"], e["date"], e["end_date"]) for e in items] == [("Viaje", "2026-09-26", "2026-09-29")]
    assert client.get("/api/events", params={"start": "2026-09-01", "end": "2026-12-01"}).status_code == 422


def test_bad_credentials_give_a_clear_error(monkeypatch):
    monkeypatch.setenv("MYCHEF_GOOGLE_CREDENTIALS", '{"type": "service_account", "client_email": "x@y", "private_key": "nada"}')
    with pytest.raises(gcal.GCalError):
        gcal.client_for("familia")
    monkeypatch.setenv("MYCHEF_GOOGLE_CREDENTIALS", "")
    with pytest.raises(gcal.GCalError, match="MYCHEF_GOOGLE_CREDENTIALS"):
        gcal.client_for("familia")

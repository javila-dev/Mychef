import datetime as dt

import pytest

from app import agenda, clock, vision
from app.models import Event, Member
from app.voice import normalize, soft

MON = dt.date(2026, 9, 28)  # lunes
FAMILY = [Member(id=1, name="Benja"), Member(id=2, name="Mamá")]


def parse(text, today=MON):
    return agenda.parse_phrase(soft(text), normalize(text), today, FAMILY)


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    monkeypatch.setattr(vision, "voice_canonical", lambda *a, **k: None)


def test_parse_phrases():
    e = parse("Recuérdame la cita de Benja con la pediatra el jueves a las 3")
    assert (e["title"], e["day"], e["time"], e["member_id"], e["category"]) == (
        "Cita de Benja con la pediatra", dt.date(2026, 10, 1), "15:00", 1, "salud")
    assert e["remind"] == [1440, 120]

    e = parse("anota en la agenda que mañana Benja tiene que llevar el uniforme de educación física")
    assert e["day"] == dt.date(2026, 9, 29) and e["time"] is None and e["category"] == "colegio"
    assert e["title"] == "Benja tiene que llevar el uniforme de educación física"

    e = parse("recuérdame pagar el arriendo el 5 de cada mes")
    assert e is None or e["category"] == "pagos"  # «el 5 de cada mes»: la IA lo resuelve si hace falta
    e = parse("recuérdame pagar el arriendo el 5 cada mes")
    assert (e["day"], e["repeat"], e["category"]) == (dt.date(2026, 10, 5), "monthly", "pagos")

    e = parse("agenda el cumpleaños de la abuela el 12 de enero")
    assert (e["day"], e["repeat"], e["category"]) == (dt.date(2027, 1, 12), "yearly", "cumpleaños")

    e = parse("recuérdame la reunión de padres el viernes a las 7 y media de la mañana")
    assert (e["day"], e["time"]) == (dt.date(2026, 10, 2), "07:30")
    e = parse("recuérdame llamar al plomero pasado mañana al mediodía")
    assert (e["day"], e["time"], e["title"]) == (dt.date(2026, 9, 30), "12:00", "Llamar al plomero")
    e = parse("recuérdame la vacuna de Benja el jueves 8")
    assert e["day"] == dt.date(2026, 10, 8)
    assert parse("recuérdame algo") is None  # sin día: se le pregunta a la IA


def test_occurrences_and_alerts():
    cumple = Event(id=1, title="Cumpleaños de la abuela", day=dt.date(2020, 2, 29), repeat="yearly", remind="1440,0")
    assert agenda.occurrences(cumple, dt.date(2027, 1, 1), dt.date(2027, 12, 31)) == [dt.date(2027, 2, 28)]
    natacion = Event(id=2, title="Natación", day=dt.date(2026, 9, 2), repeat="weekly", time="16:00")
    assert agenda.occurrences(natacion, MON, MON + dt.timedelta(days=16)) == [
        dt.date(2026, 9, 30), dt.date(2026, 10, 7), dt.date(2026, 10, 14)]
    pago = Event(id=3, title="Pagar la luz", day=dt.date(2026, 1, 31), repeat="monthly")
    assert agenda.occurrences(pago, MON, dt.date(2026, 11, 30)) == [dt.date(2026, 9, 30), dt.date(2026, 10, 31), dt.date(2026, 11, 30)]

    assert agenda.alert_time(dt.date(2026, 10, 1), "15:00", 120) == dt.datetime(2026, 10, 1, 13, 0)
    assert agenda.alert_time(dt.date(2026, 10, 1), "15:00", 1440) == dt.datetime(2026, 9, 30, 19, 30)
    assert agenda.alert_time(dt.date(2026, 10, 1), None, 0) == dt.datetime(2026, 10, 1, 7, 30)
    assert agenda.say_hour("15:30") == "a las 3 y media de la tarde"
    assert agenda.say_hour("13:00") == "a la 1 de la tarde"
    assert agenda.say_hour("07:00") == "a las 7 de la mañana"


def test_events_api_and_reminders(client):
    benja = client.post("/api/members", json={"name": "Benja"}).json()
    today = clock.today()
    tomorrow = today + dt.timedelta(days=1)
    res = client.post("/api/events", json={
        "title": "Cita con la pediatra", "category": "salud", "member_id": benja["id"],
        "day": tomorrow.isoformat(), "time": "15:00", "remind": [1440, 120],
    })
    assert res.status_code == 201 and res.json()["day_text"] == "mañana"
    ev = res.json()
    items = client.get("/api/events").json()
    assert [(i["title"], i["member"]["name"]) for i in items] == [("Cita con la pediatra", "Benja")]

    # el aviso del día antes cae hoy a las 7:30 p. m.
    rem = [r for r in client.get("/api/reminders").json()["items"] if r.get("kind") == "event"]
    assert [(r["remind_at"], r["say"]) for r in rem] == [
        ("19:30", "Recordatorio: mañana a las 3 de la tarde, Cita con la pediatra de Benja.")]

    client.post(f"/api/events/{ev['id']}/done")
    assert client.get("/api/events").json() == []
    assert [r for r in client.get("/api/reminders").json()["items"] if r.get("kind") == "event"] == []
    assert client.post("/api/events", json={"title": "x", "day": "2026-10-01", "time": "25:00"}).status_code == 422
    client.delete(f"/api/members/{benja['id']}")  # la cita queda, sin persona
    assert client.delete(f"/api/events/{ev['id']}").status_code == 204


def test_voice_agenda(client):
    client.post("/api/members", json={"name": "Benja"})
    say = lambda text: client.post("/api/voice", json={"text": text, "context": {}}).json()  # noqa: E731
    r = say("Oye casa, recuérdame la cita de Benja con la pediatra el jueves a las 3")
    assert r["intent"] == "agenda_add"
    assert r["speak"].startswith("Listo, anoté Cita de Benja con la pediatra para ")
    assert "a las 3 de la tarde" in r["speak"] and "Les aviso el día antes y dos horas antes." in r["speak"]
    assert r["undo"]["steps"][0]["method"] == "DELETE"

    assert "Cita de Benja con la pediatra" in say("¿qué hay en la agenda?")["speak"]
    # lo de siempre sigue igual
    assert say("recuérdame en diez minutos sacar el pollo")["intent"] == "timer_set"
    assert say("agrega pan a la lista")["intent"] == "list_add"
    assert say("recuérdame algo importante")["intent"] == "agenda_ask"  # sin día y sin IA

"""«Oye casa, recuérdame…»: si falta el día o la hora, la casa pregunta y une la respuesta."""

import datetime as dt

from app import clock

TODAY = clock.today()


def _talk(client):
    state = {"pending": None}

    def say(text):
        context = {"pending": state["pending"]} if state["pending"] else {}
        res = client.post("/api/voice", json={"text": text, "context": context}).json()
        state["pending"] = res["data"].get("pending") if res["intent"] == "agenda_ask" else None
        return res

    return say


def _events(client):
    return client.get("/api/events", params={"start": TODAY.isoformat(), "days": 40}).json()


def test_asks_for_day_then_time(client):
    say = _talk(client)
    r = say("Oye casa, recuérdame llamar a la abuela")
    assert r["intent"] == "agenda_ask" and r["speak"] == "¿Para qué día es «Llamar a la abuela»?"
    assert r["data"]["pending"]["need"] == "day"

    r = say("pasado mañana")
    assert r["intent"] == "agenda_ask" and r["speak"].startswith("¿A qué hora?")

    r = say("a las 4 de la tarde")
    assert r["intent"] == "agenda_add"
    assert r["data"]["title"] == "Llamar a la abuela"
    assert r["data"]["date"] == (TODAY + dt.timedelta(days=2)).isoformat()
    assert r["data"]["time"] == "16:00"
    assert "Les aviso una hora antes." in r["speak"]


def test_day_and_time_in_one_answer_and_short_hours(client):
    say = _talk(client)
    say("recuérdame pagar el internet")
    r = say("mañana a las 10 de la mañana")
    assert (r["intent"], r["data"]["time"]) == ("agenda_add", "10:00")

    say("recuérdame llamar al plomero mañana")
    r = say("las tres y media")
    assert (r["intent"], r["data"]["time"]) == ("agenda_add", "15:30")


def test_all_day_and_birthdays_do_not_need_time(client):
    say = _talk(client)
    assert say("recuérdame sacar la basura mañana")["intent"] == "agenda_ask"
    r = say("todo el día")
    assert r["intent"] == "agenda_add" and r["data"]["time"] is None
    assert "Les aviso ese día." in r["speak"]

    r = say("recuérdame el cumpleaños de la abuela el 3 de diciembre")
    assert r["intent"] == "agenda_add"  # los cumpleaños no piden hora


def test_cancel_retry_and_change_of_topic(client):
    say = _talk(client)
    say("recuérdame llamar a la abuela")
    assert say("olvídalo")["intent"] == "agenda_cancel"
    assert _events(client) == []

    say("recuérdame llamar a la abuela")
    r = say("azul")
    assert r["intent"] == "agenda_ask" and r["speak"].startswith("No entendí.")
    assert say("verde")["intent"] == "agenda_cancel"  # a la segunda se rinde

    say("recuérdame llamar a la abuela")
    assert say("agrega pan a la lista")["intent"] == "list_add"  # otra cosa: se atiende normal
    assert _events(client) == []

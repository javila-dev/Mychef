"""Voz para la comida: sobras, poner platos en el menú, el menú de otros días y lo que hay en la casa."""

import datetime as dt

import pytest

from app import clock, vision

from .test_voice import say, seed

TODAY = clock.today()


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    monkeypatch.setattr(vision, "voice_canonical", lambda *a, **k: None)


def undo(client, r):
    for step in r["undo"]["steps"]:
        client.request(step["method"], step["url"], json=step.get("json"))


def lefts(client):
    return {x["name"]: x for x in client.get("/api/leftovers").json()}


@pytest.mark.parametrize("text,name,portions,place", [
    ("guardé frijoles en el congelador", "Frijoles", 4, "congelador"),
    ("guardamos sobras de bolognesa, 4 porciones, en el congelador", "Bolognesa", 4, "congelador"),
    ("sobraron tres porciones de lasaña", "Lasaña", 3, "nevera"),
    ("sobró pizza", "Pizza", 4, "nevera"),
    ("anota sobras de arroz de pollo en la nevera", "Arroz de pollo", 4, "nevera"),
])
def test_save_leftovers(client, text, name, portions, place):
    r = say(client, text)
    assert r["intent"] == "leftover_add", r
    got = lefts(client)[name]
    assert (got["portions"], got["place"]) == (portions, place)  # sin decir cuántas: una comida de la casa (4 adultos)
    undo(client, r)
    assert name not in lefts(client)


def test_ask_eat_and_finish_leftovers(client):
    say(client, "guardé sobras de frijoles, 6 porciones, en el congelador")
    r = say(client, "¿qué sobras hay?")
    assert r["intent"] == "leftovers" and "frijoles, 6 porciones en el congelador" in r["speak"]
    assert say(client, "muéstrame las sobras")["navigate"] == {"screen": "leftovers"}

    r = say(client, "ya nos comimos dos porciones de frijoles")
    assert r["intent"] == "leftover_eat" and "Quedan 4 porciones" in r["speak"]
    undo(client, r)
    assert lefts(client)["Frijoles"]["portions"] == 6

    r = say(client, "se botaron las sobras de frijoles")
    assert r["intent"] == "leftover_done" and lefts(client) == {}
    undo(client, r)
    assert lefts(client)["Frijoles"]["portions"] == 6


def test_eating_takes_the_plate_that_was_in_the_menu(client):
    say(client, "guardé sobras de bolognesa, 5 porciones, en el congelador")
    r = say(client, "hoy almorzamos sobras de bolognesa")
    assert r["intent"] == "menu_add" and "sobras de bolognesa" in r["speak"]
    r = say(client, "ya nos comimos la bolognesa")
    assert r["intent"] == "leftover_eat"
    plate = client.get(f"/api/menu/leftovers?start={TODAY.isoformat()}&days=1").json()[0]
    assert plate["eaten"] and plate["leftover"]["portions"] == 1  # la comida de la casa: 4 porciones


def test_put_recipe_in_menu_with_side_leftovers(client):
    seed(client)
    say(client, "guardé frijoles en el congelador, 8 porciones")
    r = say(client, "mañana almorzamos sopa de lentejas con sobras de frijoles")
    assert r["intent"] == "menu_add", r
    day = (TODAY + dt.timedelta(days=1)).isoformat()
    menu = client.get(f"/api/menu?start={day}&days=1").json()
    assert [(e["meal_type"], e["recipe"]["name"]) for e in menu] == [("almuerzo", "Sopa de lentejas")]
    plates = client.get(f"/api/menu/leftovers?start={day}&days=1").json()
    assert [p["leftover"]["name"] for p in plates] == ["Frijoles"]

    q = say(client, "¿qué hay de almuerzo mañana?")
    assert q["intent"] == "menu_today" and "sopa de lentejas" in q["speak"] and "sobras de frijoles" in q["speak"]

    undo(client, r)
    assert client.get(f"/api/menu?start={day}&days=1").json() == []
    assert client.get(f"/api/menu/leftovers?start={day}&days=1").json() == []


def test_pon_in_menu_is_not_an_agenda_reminder(client):
    seed(client)
    r = say(client, "pon lentejas el jueves de almuerzo")
    assert r["intent"] == "menu_add"
    assert "de almuerzo: sopa de lentejas" in r["speak"]
    # un temporizador «para el almuerzo» sigue siendo un temporizador
    assert say(client, "pon un temporizador de diez minutos para el almuerzo")["intent"] == "timer_set"
    # y lo que es de la lista, de la lista
    assert say(client, "agrega pan a la lista para el desayuno")["intent"] == "list_add"


def test_menu_unknown_recipe(client):
    seed(client)
    r = say(client, "pon ajiaco en el menú del viernes de cena")
    assert r["intent"] == "menu_unknown"


def test_pantry_questions(client):
    seed(client)
    r = say(client, "¿hay leche?")
    assert r["intent"] == "pantry_query" and r["speak"].startswith("Sí, hay 2 litros de leche")
    r = say(client, "cuánta leche queda")
    assert r["intent"] == "pantry_query" and "2 litros" in r["speak"]
    r = say(client, "¿tenemos queso?")
    assert r["intent"] == "pantry_query" and r["speak"].startswith("No hay queso")
    # «hay que comprar» sigue siendo la lista
    assert say(client, "hay que comprar café")["intent"] == "list_add"


def test_remove_from_list(client):
    say(client, "agrega pan y queso a la lista")
    r = say(client, "quita el pan de la lista")
    assert r["intent"] == "list_remove" and r["data"]["items"] == ["pan"]
    r = say(client, "ya compré el queso")
    assert r["intent"] == "list_remove"
    names = {i["name"] for i in client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()}
    assert names == set()
    undo(client, r)
    names = {i["name"] for i in client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()}
    assert names == {"Queso"}


def test_stars_and_navigation(client):
    kid = client.post("/api/members", json={"name": "Benja", "kid": True}).json()
    chore = client.post("/api/chores", json={"name": "Tender la cama", "every_days": 1, "stars": 2}).json()
    client.post(f"/api/chores/{chore['id']}/done", json={"member_id": kid["id"]})
    r = say(client, "¿cuántas estrellas tiene Benja?")
    assert r["intent"] == "stars" and r["speak"].startswith("Benja lleva 2 estrellas")
    assert say(client, "abre los logros")["navigate"] == {"screen": "stars"}
    assert say(client, "armemos el menú")["navigate"] == {"screen": "sunday"}
    assert say(client, "menú de la semana")["navigate"] == {"screen": "menu"}
    assert say(client, "abre el inventario")["navigate"] == {"screen": "inventory"}


def test_phrases_that_are_not_food_commands(client):
    assert say(client, "¿hay algo que se venza?")["intent"] == "expiring"
    assert say(client, "hoy almorzamos sobras")["speak"] == "No hay sobras anotadas."
    assert say(client, "hoy comemos a las dos")["intent"] == "unknown"
    assert say(client, "pon música")["intent"] == "unknown"

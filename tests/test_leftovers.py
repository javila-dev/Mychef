"""Sobras: lo que quedó en la nevera o el congelador se come por porciones, solo o al lado de una receta."""

import datetime as dt

from app import clock

from .test_planner import ARROZ, POLLO, START, house, plan, rec, stock

TODAY = clock.today()


def add(client, name="Frijoles", portions=6, place="congelador", **kw):
    r = client.post("/api/leftovers", json={"name": name, "portions": portions, "place": place, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def put(client, left_id, day=TODAY, meal="almuerzo", **kw):
    r = client.post("/api/menu/leftovers", json={"day": day.isoformat(), "meal_type": meal, "leftover_id": left_id, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_save_and_list_leftovers(client):
    add(client, "bolognesa", 4, "congelador")
    add(client, "Arroz de pollo", 3, "nevera", made_on=(TODAY - dt.timedelta(days=3)).isoformat())
    got = client.get("/api/leftovers").json()
    # Primero la nevera (se daña antes)
    assert [x["name"] for x in got] == ["Arroz de pollo", "Bolognesa"]
    assert got[0]["old"] is True and got[0]["days"] == 3
    assert got[1]["old"] is False
    assert client.post("/api/leftovers", json={"name": "x", "portions": 1, "place": "alacena"}).status_code == 422


def test_eating_takes_portions_and_does_not_touch_the_pantry(client):
    stock(client, POLLO)
    before = client.get("/api/pantry").json()
    left = add(client, portions=6)
    plate = put(client, left["id"], servings=2, kids=0)
    assert plate["portions"] == 2
    assert client.get("/api/leftovers").json()[0]["free"] == 4  # dos ya están en el menú
    # No pide nada a la lista de compras
    week = TODAY - dt.timedelta(days=TODAY.weekday())
    assert not any(i["reason"] == "menu" for i in client.get(f"/api/shopping-list?start={week.isoformat()}").json())

    eaten = client.post(f"/api/menu/leftovers/{plate['id']}/eat").json()
    assert eaten["eaten"] is True and eaten["leftover"]["portions"] == 4
    assert client.post(f"/api/menu/leftovers/{plate['id']}/eat").status_code == 409
    assert client.get("/api/pantry").json() == before

    # Un toque equivocado: se deshace
    back = client.post(f"/api/menu/leftovers/{plate['id']}/uneat").json()
    assert back["eaten"] is False and back["leftover"]["portions"] == 6


def test_finished_leftovers_leave_the_menu(client):
    left = add(client, portions=2)
    put(client, left["id"])
    assert client.delete(f"/api/leftovers/{left['id']}").json() == {"removed_from_menu": 1}
    assert client.get("/api/leftovers").json() == []
    assert client.get(f"/api/menu/leftovers?start={TODAY.isoformat()}&days=1").json() == []
    assert client.post("/api/menu/leftovers", json={"day": TODAY.isoformat(), "meal_type": "cena",
                                                    "leftover_id": left["id"]}).status_code == 409


def test_cooking_the_meal_eats_the_side_leftovers(client):
    rid = rec(client, "Arroz blanco", ["almuerzo"], "plato principal", ARROZ)
    stock(client, ARROZ)
    entry = client.post("/api/menu", json={"day": TODAY.isoformat(), "meal_type": "almuerzo", "recipe_id": rid,
                                           "servings": 2, "kids": 0}).json()
    left = add(client, portions=5)
    put(client, left["id"], servings=2, kids=0)
    res = client.post(f"/api/menu/{entry['id']}/cook").json()
    assert res["leftovers_eaten"] == ["Frijoles"]
    assert client.get("/api/leftovers").json()[0]["portions"] == 3


def test_today_shows_leftover_meals(client):
    left = add(client, "Bolognesa", 4, "nevera", made_on=(TODAY - dt.timedelta(days=4)).isoformat())
    put(client, left["id"], meal="cena")
    today = client.get("/api/today").json()
    assert [p["leftover"]["name"] for p in today["leftover_meals"]] == ["Bolognesa"]
    assert today["leftovers"][0]["old"] is True


def test_sunday_plan_offers_leftovers_and_saves_them(client):
    ids = house(client)
    left = add(client, portions=8)
    day = START.isoformat()
    week = plan(client, [(0, "almuerzo"), (0, "cena")])
    assert [x["name"] for x in week["leftovers"]] == ["Frijoles"]

    # Almuerzo: arroz con pollo + frijoles; cena: solo sobras
    r = client.post("/api/menu/week", json={
        "entries": [{"day": day, "meal_type": "almuerzo", "recipe_id": ids["arroz_pollo"], "servings": 2, "kids": 0}],
        "leftovers": [{"day": day, "meal_type": "almuerzo", "leftover_id": left["id"], "servings": 2, "kids": 0},
                      {"day": day, "meal_type": "cena", "leftover_id": left["id"], "servings": 2, "kids": 0}],
        "replace": [{"day": day, "meal": "almuerzo"}, {"day": day, "meal": "cena"}],
    })
    assert r.status_code == 201, r.text
    plates = client.get(f"/api/menu/leftovers?start={day}&days=1").json()
    assert sorted(p["meal_type"] for p in plates) == ["almuerzo", "cena"]

    # Al volver a planear, esas comidas ya están (la cena, aunque sea solo sobras)
    again = plan(client, [(0, "almuerzo"), (0, "cena")])
    cena = next(s for s in again["slots"] if s["meal"] == "cena")
    assert cena["fixed"] and cena["entries"] == [] and cena["leftovers"] == ["Frijoles"]
    assert again["leftovers"][0]["free"] == 4

    # Rehacer la semana quita las sobras que no se habían comido
    redo = plan(client, [(0, "almuerzo"), (0, "cena")], keep_existing=False)
    assert redo["leftovers"][0]["free"] == 8
    client.post("/api/menu/week", json={"entries": [], "replace": [{"day": day, "meal": "cena"}]})
    assert [p["meal_type"] for p in client.get(f"/api/menu/leftovers?start={day}&days=1").json()] == ["almuerzo"]


def test_deleting_the_recipe_keeps_the_leftovers(client):
    rid = rec(client, "Frijoles antioqueños", ["almuerzo"], "plato principal", ("Frijol", 500, "g", "legumbres"))
    add(client, "Frijoles antioqueños", 6, recipe_id=rid)
    assert client.delete(f"/api/recipes/{rid}").status_code == 204
    got = client.get("/api/leftovers").json()
    assert got[0]["recipe_id"] is None and got[0]["portions"] == 6

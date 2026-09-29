"""El menú del domingo: arma la semana con lo que hay, sin repetir la semana pasada y repartiendo proteínas."""

import datetime as dt

START = dt.date(2026, 10, 5)  # lunes
LAST_WEEK = START - dt.timedelta(days=3)


def rec(client, name, meals, dish="plato principal", *ings, favorite=False):
    data = {"name": name, "meal_types": meals, "dish_type": dish, "servings": 4, "favorite": favorite,
            "ingredients": [{"name": n, "quantity": q, "unit": u, "category": c} for n, q, u, c in ings]}
    r = client.post("/api/recipes", json=data)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def stock(client, *items):
    for name, q, unit, cat in items:
        assert client.post("/api/pantry", json={"name": name, "quantity": q, "unit": unit, "category": cat}).status_code == 201


def plan(client, slots, **kw):
    r = client.post("/api/menu/plan", json={"start": START.isoformat(), "slots": [
        {"day": (START + dt.timedelta(days=d)).isoformat(), "meal": m} for d, m in slots], **kw})
    assert r.status_code == 200, r.text
    return r.json()


POLLO = ("Pollo", 600, "g", "carnes")
RES = ("Carne de res", 600, "g", "carnes")
CERDO = ("Cerdo", 600, "g", "carnes")
LENTEJAS = ("Lentejas", 300, "g", "legumbres")
ARROZ = ("Arroz", 400, "g", "granos y harinas")
PAPA = ("Papa", 500, "g", "verduras")
TOMATE = ("Tomate", 2, "unidad", "verduras")
HUEVO = ("Huevo", 6, "unidad", "lácteos y huevos")


def house(client):
    ids = {
        "arroz_pollo": rec(client, "Arroz con pollo", ["almuerzo", "cena"], "plato principal", POLLO, ARROZ),
        "pollo_sudado": rec(client, "Pollo sudado", ["almuerzo", "cena"], "plato principal", POLLO, PAPA),
        "carne": rec(client, "Carne en bistec", ["almuerzo", "cena"], "plato principal", RES, ARROZ),
        "cerdo": rec(client, "Cerdo con papa", ["almuerzo", "cena"], "plato principal", CERDO, PAPA),
        "lentejas": rec(client, "Lentejas con arroz", ["almuerzo", "cena"], "plato principal", LENTEJAS, ARROZ),
        "pericos": rec(client, "Huevos pericos", ["desayuno"], "plato principal", HUEVO, TOMATE),
    }
    for _ in range(3):  # hay de sobra para toda la semana
        stock(client, POLLO, RES, CERDO, LENTEJAS, ARROZ, PAPA, TOMATE, HUEVO)
    return ids


def names(slot):
    return slot["main"]["recipe"]["name"] if slot.get("main") else None


def test_proteins_are_spread_over_the_week(client):
    house(client)
    week = plan(client, [(d, m) for d in range(3) for m in ("almuerzo", "cena")])["slots"]
    mains = [s["main"] for s in week]
    assert all(m for m in mains)
    # Ninguna receta se repite mientras haya otras, y el almuerzo y la cena no llevan la misma proteína
    assert len({m["recipe"]["id"] for m in mains}) == 5  # hay 5 recetas de almuerzo/cena
    for d in range(3):
        lunch, dinner = week[2 * d]["main"], week[2 * d + 1]["main"]
        assert lunch["protein"] != dinner["protein"]
    # Cada plato dice su proteína y su harina (lo que se ve en la tarjeta)
    assert {m["recipe"]["name"]: (m["protein"], m["starch"]) for m in mains}["Lentejas con arroz"] == ("Lentejas", "Arroz")


def test_last_week_is_not_repeated(client):
    ids = house(client)
    client.post("/api/menu", json={"day": LAST_WEEK.isoformat(), "meal_type": "almuerzo", "recipe_id": ids["arroz_pollo"]})
    res = plan(client, [(d, m) for d in range(2) for m in ("almuerzo", "cena")])
    chosen = {names(s) for s in res["slots"]}
    assert "Arroz con pollo" not in chosen
    assert set(res["recent"]) >= {"Arroz con pollo"}


def test_repeats_only_when_there_is_nothing_else(client):
    ids = {"solo": rec(client, "Arroz con pollo", ["almuerzo"], "plato principal", POLLO, ARROZ)}
    stock(client, POLLO, ARROZ)
    client.post("/api/menu", json={"day": LAST_WEEK.isoformat(), "meal_type": "almuerzo", "recipe_id": ids["solo"]})
    [slot] = plan(client, [(0, "almuerzo")])["slots"]
    assert slot["main"]["recipe"]["id"] == ids["solo"] and slot["main"]["repeat"] is True


def test_breakfast_and_dinner_rules(client):
    house(client)
    week = plan(client, [(0, "desayuno"), (0, "cena")])["slots"]
    assert names(week[0]) == "Huevos pericos" and week[0]["main"]["protein"] == "Huevo"
    assert week[0]["main"]["starch"] is None  # el tomate no es harina
    # Lo que es solo de desayuno nunca sale en la cena
    assert all(o["recipe"]["name"] != "Huevos pericos" for o in week[1]["main_options"])


def test_lunch_brings_a_salad_that_does_not_repeat_the_starch(client):
    rec(client, "Pollo sudado", ["almuerzo", "cena"], "plato principal", POLLO, PAPA)
    rec(client, "Ensalada de papa", ["almuerzo"], "ensalada", PAPA, ("Mayonesa", 50, "g", "aceites y salsas"))
    rec(client, "Ensalada de tomate y cebolla", ["almuerzo"], "ensalada", TOMATE, ("Cebolla", 1, "unidad", "verduras"))
    stock(client, POLLO, PAPA, PAPA, TOMATE, ("Cebolla", 3, "unidad", "verduras"), ("Mayonesa", 200, "g", "aceites y salsas"))
    lunch, dinner = plan(client, [(0, "almuerzo"), (0, "cena")])["slots"]
    assert names(lunch) == "Pollo sudado"
    assert lunch["salad"]["recipe"]["name"] == "Ensalada de tomate y cebolla"
    assert [o["recipe"]["name"] for o in lunch["salad_options"]] == ["Ensalada de tomate y cebolla", "Ensalada de papa"]
    assert "salad" not in dinner  # la ensalada va solo al almuerzo


def test_snack_is_only_for_who_eats_it(client):
    benja = client.post("/api/members", json={"name": "Benja", "kid": True}).json()["id"]
    r = client.put("/api/settings", json={"meal_people": {"merienda": [benja]}})
    assert r.status_code == 200 and r.json()["meal_people"] == {"merienda": [benja]}
    assert client.get("/api/meta").json()["meal_people"] == {"merienda": [benja]}
    fruta = rec(client, "Salpicón", ["merienda"], "postre", ("Banano", 1, "unidad", "frutas"))
    stock(client, ("Banano", 6, "unidad", "frutas"))
    [slot] = plan(client, [(0, "merienda")])["slots"]
    assert (slot["adults"], slot["kids"]) == (0, 1) and names(slot) == "Salpicón"
    # También al ponerla a mano en el menú
    e = client.post("/api/menu", json={"day": START.isoformat(), "meal_type": "merienda", "recipe_id": fruta}).json()
    assert (e["servings"], e["kids"]) == (0, 1)
    # Las otras comidas siguen siendo de toda la casa
    assert client.post("/api/menu", json={"day": START.isoformat(), "meal_type": "almuerzo", "recipe_id": fruta}).json()["servings"] == 4
    assert client.put("/api/settings", json={"meal_people": {"merienda": [9999]}}).status_code == 422
    assert client.put("/api/settings", json={"meal_people": {"onces": [benja]}}).status_code == 422
    # Si Benja ya no está en la casa, la merienda vuelve a ser de todos
    client.delete(f"/api/members/{benja}")
    assert client.get("/api/meta").json()["meal_people"] == {}


def test_what_is_already_in_the_menu_stays(client):
    ids = house(client)
    client.post("/api/menu", json={"day": START.isoformat(), "meal_type": "almuerzo", "recipe_id": ids["cerdo"]})
    lunch, dinner = plan(client, [(0, "almuerzo"), (0, "cena")])["slots"]
    assert lunch["fixed"] and lunch["entries"][0]["recipe"]["name"] == "Cerdo con papa"
    assert "ai_rank" not in lunch
    assert dinner["main"]["protein"] != "Cerdo" and dinner["ai_rank"] == 1
    # Rehacer todo: lo que había no cuenta
    lunch, _ = plan(client, [(0, "almuerzo"), (0, "cena")], keep_existing=False)["slots"]
    assert not lunch["fixed"]


def test_starch_is_a_whole_word(client):
    rec(client, "Salpicón", ["merienda"], "postre", ("Papaya", 1, "unidad", "frutas"))
    rec(client, "Papas criollas", ["merienda"], "snack", ("Papa criolla", 500, "g", "verduras"))
    starch = {o["recipe"]["name"]: o["starch"] for o in plan(client, [(0, "merienda")])["slots"][0]["main_options"]}
    assert starch == {"Salpicón": None, "Papas criollas": "Papa criolla"}


def test_few_recipes_repeat_in_the_week_and_say_so(client):
    rec(client, "Arroz con pollo", ["almuerzo"], "plato principal", POLLO, ARROZ)
    stock(client, POLLO, POLLO, ARROZ, ARROZ)
    mon, tue = plan(client, [(0, "almuerzo"), (1, "almuerzo")])["slots"]
    assert (mon["main"]["again"], tue["main"]["again"]) == (0, 1)
    assert tue["ai_rank"] == 1  # lo repetido es lo primero que conviene cambiar por una idea nueva


def test_ai_rank_starts_with_what_the_house_solves_worst(client):
    rec(client, "Arroz con pollo", ["almuerzo"], "plato principal", POLLO, ARROZ)
    stock(client, POLLO, ARROZ)
    rec(client, "Pescado frito", ["cena"], "plato principal", ("Mojarra", 2, "unidad", "pescados"))  # no hay mojarra
    slots = plan(client, [(0, "almuerzo"), (0, "cena"), (0, "desayuno")])["slots"]
    by_meal = {s["meal"]: s for s in slots}
    assert by_meal["desayuno"]["main"] is None and by_meal["desayuno"]["ai_rank"] == 1  # no hay receta
    assert by_meal["cena"]["ai_rank"] == 2  # hay receta, pero falta la mojarra
    assert by_meal["almuerzo"]["ai_rank"] == 3


def test_save_week(client):
    ids = house(client)
    mon, tue = START.isoformat(), (START + dt.timedelta(days=1)).isoformat()
    old = client.post("/api/menu", json={"day": mon, "meal_type": "almuerzo", "recipe_id": ids["cerdo"]}).json()
    cooked = client.post("/api/menu", json={"day": mon, "meal_type": "cena", "recipe_id": ids["carne"]}).json()
    client.post(f"/api/menu/{cooked['id']}/cook")
    r = client.post("/api/menu/week", json={
        "entries": [
            {"day": mon, "meal_type": "almuerzo", "recipe_id": ids["arroz_pollo"]},
            {"day": tue, "meal_type": "cena", "recipe_id": ids["lentejas"], "servings": 2, "kids": 0},
        ],
        "replace": [{"day": mon, "meal": "almuerzo"}, {"day": mon, "meal": "cena"}],
    })
    assert r.status_code == 201, r.text
    menu = client.get(f"/api/menu?start={mon}&days=2").json()
    got = sorted((e["day"], e["meal_type"], e["recipe"]["name"], e["servings"]) for e in menu)
    assert got == [(mon, "almuerzo", "Arroz con pollo", 4), (mon, "cena", "Carne en bistec", 4),
                   (tue, "cena", "Lentejas con arroz", 2)]
    assert all(e["id"] != old["id"] for e in menu)  # lo de antes sin cocinar se reemplazó; lo cocinado quedó
    bad = client.post("/api/menu/week", json={"entries": [{"day": mon, "meal_type": "almuerzo", "recipe_id": 999}]})
    assert bad.status_code == 404

"""Adultos y niños: el niño come una porción más pequeña, y el inventario se puede llevar por porciones."""

from app import clock

TODAY = clock.today()


def _recipe(client):
    return client.post("/api/recipes", json={
        "name": "Cerdo en salsa", "meal_types": ["almuerzo"], "servings": 4,
        "ingredients": [{"name": "Cerdo", "quantity": 800, "unit": "g", "category": "carnes"}],
    }).json()


def test_kids_eat_a_smaller_portion(client):
    client.put("/api/settings", json={"household_size": 2, "household_kids": 1, "kid_portion": 0.5})
    meta = client.get("/api/meta").json()
    assert (meta["household_size"], meta["household_kids"], meta["kid_portion"]) == (2, 1, 0.5)

    r = _recipe(client)
    # 2 adultos y 1 niño = 2,5 porciones: 800 g para 4 -> 500 g
    d = client.get(f"/api/recipes/{r['id']}", params={"servings": 2, "kids": 1}).json()
    assert (d["adults"], d["kids"], d["ingredients"][0]["quantity"]) == (2, 1, 500)

    # El menú usa la casa por defecto y la lista de compras cuenta al niño como media porción
    entry = client.post("/api/menu", json={"day": TODAY.isoformat(), "meal_type": "almuerzo", "recipe_id": r["id"]}).json()
    assert (entry["servings"], entry["kids"]) == (2, 1)
    [line] = client.get("/api/shopping-list", params={"start": TODAY.isoformat(), "days": 1}).json()
    assert (line["name"], line["quantity"], line["unit"]) == ("Cerdo", 500, "g")

    # Si Benja come igual que un adulto, alcanza para 3 porciones
    client.put("/api/settings", json={"kid_portion": 1})
    [line] = client.get("/api/shopping-list", params={"start": TODAY.isoformat(), "days": 1}).json()
    assert line["quantity"] == 600


def test_pantry_by_portions(client):
    client.put("/api/settings", json={"household_size": 2, "household_kids": 1, "kid_portion": 0.5})
    r = _recipe(client)
    # "Cerdo: comida para 2 adultos y 1 niño" = 2,5 porciones
    client.post("/api/pantry", json={"name": "Cerdo", "quantity": 2.5, "unit": "porción", "category": "carnes"})
    [item] = client.get("/api/pantry").json()
    assert (item["quantity"], item["unit"]) == (2.5, "porcion")

    d = client.get(f"/api/recipes/{r['id']}", params={"servings": 2, "kids": 1}).json()
    assert d["availability"]["can_cook"] is True
    d = client.get(f"/api/recipes/{r['id']}", params={"servings": 4}).json()
    assert d["availability"]["can_cook"] is False  # para 4 adultos no alcanza

    client.post(f"/api/recipes/{r['id']}/cook", json={"servings": 2, "kids": 1})
    [item] = client.get("/api/pantry").json()
    assert item["quantity"] == 0

    # En la revisión de la casa se puede pasar a porciones
    client.post("/api/pantry", json={"name": "Pollo", "quantity": 1, "unit": "kg", "category": "carnes"})
    pollo = next(i for i in client.get("/api/pantry").json() if i["name"] == "Pollo")
    client.post("/api/inventory/proteinas/review", json={"items": [
        {"id": pollo["id"], "state": "ok", "quantity": 5, "unit": "porcion"},
    ]})
    pollo = next(i for i in client.get("/api/pantry").json() if i["name"] == "Pollo")
    assert (pollo["quantity"], pollo["unit"]) == (5, "porcion")


def test_menu_needs_someone_to_eat(client):
    r = _recipe(client)
    res = client.post("/api/menu", json={"day": TODAY.isoformat(), "meal_type": "almuerzo", "recipe_id": r["id"],
                                         "servings": 0, "kids": 0})
    assert res.status_code == 422


def test_week_menu_says_what_is_missing(client):
    r = _recipe(client)
    client.post("/api/menu", json={"day": TODAY.isoformat(), "meal_type": "almuerzo", "recipe_id": r["id"]})
    [e] = client.get("/api/menu", params={"start": TODAY.isoformat(), "days": 1}).json()
    assert (e["can_cook"], e["missing"]) == (False, ["Cerdo"])
    client.post("/api/pantry", json={"name": "Cerdo", "quantity": 2, "unit": "kg"})
    [e] = client.get("/api/menu", params={"start": TODAY.isoformat(), "days": 1}).json()
    assert (e["can_cook"], e["missing"]) == (True, [])

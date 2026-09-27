import datetime as dt

import pytest

from app import vision
from app.models import ingredient_key
from app.units import convert, humanize, normalize_unit

MONDAY = dt.date(2026, 9, 28)


def arroz_con_pollo(**kw):
    data = {
        "name": "Arroz con pollo de la abuela",
        "meal_types": ["almuerzo", "cena"],
        "dish_type": "plato principal",
        "servings": 4,
        "ingredients": [
            {"name": "Arroz", "quantity": 500, "unit": "g", "category": "granos y harinas"},
            {"name": "Pechuga de pollo", "quantity": 1, "unit": "kg", "category": "carnes"},
            {"name": "Zanahorias", "quantity": 2, "unit": "unidad", "category": "verduras"},
            {"name": "Cilantro", "quantity": 1, "unit": "cda", "optional": True},
        ],
    }
    data.update(kw)
    return data


def test_units():
    assert normalize_unit("Gramos") == "g"
    assert normalize_unit("cucharadas") == "cda"
    assert convert(1, "kg", "g") == 1000
    assert convert(2, "taza", "ml") == 480
    assert convert(1, "kg", "ml") is None
    assert humanize(1500, "g") == (1.5, "kg")


def test_ingredient_key_matches_plural_and_accents():
    assert ingredient_key("Tomates") == ingredient_key("tomate")
    assert ingredient_key("Limones") == ingredient_key("limón")
    assert ingredient_key("  Cebollas  Rojas ") == ingredient_key("cebolla roja")


def test_recipe_scaling_keeps_proportions(client):
    r = client.post("/api/recipes", json=arroz_con_pollo()).json()
    scaled = client.get(f"/api/recipes/{r['id']}", params={"servings": 6}).json()
    qty = {i["name"]: i["quantity"] for i in scaled["ingredients"]}
    assert qty["Arroz"] == 750
    assert qty["Pechuga de pollo"] == 1.5
    assert qty["Zanahorias"] == 3
    assert scaled["factor"] == 1.5


def test_availability_and_suggestions(client):
    r = client.post("/api/recipes", json=arroz_con_pollo()).json()
    client.post("/api/recipes", json={
        "name": "Huevos pericos", "meal_types": ["desayuno"], "servings": 2,
        "ingredients": [{"name": "Huevo", "quantity": 4, "unit": "unidad"}],
    })
    client.post("/api/pantry/bulk", json=[
        {"name": "arroz", "quantity": 2, "unit": "kilos"},
        {"name": "pechuga de pollo", "quantity": 600, "unit": "gr"},
        {"name": "zanahoria", "quantity": 5, "unit": "unidades"},
    ])
    detail = client.get(f"/api/recipes/{r['id']}", params={"servings": 4}).json()
    status = {i["name"]: i["status"] for i in detail["availability"]["items"]}
    assert status == {"Arroz": "ok", "Pechuga de pollo": "poco", "Zanahorias": "ok", "Cilantro": "falta"}
    assert detail["availability"]["can_cook"] is False  # falta pollo; el cilantro es opcional

    sugg = client.get("/api/suggestions", params={"meal_type": "almuerzo", "servings": 2}).json()
    assert [s["recipe"]["name"] for s in sugg] == ["Arroz con pollo de la abuela"]
    assert sugg[0]["can_cook"] is True  # para 2 porciones sí alcanza el pollo (500 g)

    breakfast = client.get("/api/suggestions", params={"meal_type": "desayuno"}).json()
    assert breakfast[0]["recipe"]["name"] == "Huevos pericos"
    assert breakfast[0]["missing"] == [{"name": "Huevo", "quantity": 8.0, "unit": "unidad"}]


def test_expiring_ingredients_rank_first(client):
    client.post("/api/recipes", json={
        "name": "Crema de espinaca", "meal_types": ["cena"], "dish_type": "sopa", "servings": 4,
        "ingredients": [{"name": "Espinaca", "quantity": 300, "unit": "g"}],
    })
    client.post("/api/recipes", json={
        "name": "Lentejas", "meal_types": ["cena"], "dish_type": "sopa", "servings": 4,
        "ingredients": [{"name": "Lenteja", "quantity": 300, "unit": "g"}],
    })
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    client.post("/api/pantry", json={"name": "espinaca", "quantity": 400, "unit": "g", "expires_on": tomorrow})
    client.post("/api/pantry", json={"name": "lentejas", "quantity": 1, "unit": "kg"})
    sugg = client.get("/api/suggestions", params={"meal_type": "cena"}).json()
    assert sugg[0]["recipe"]["name"] == "Crema de espinaca"
    assert sugg[0]["uses_expiring"] == ["Espinaca"]
    pantry = client.get("/api/pantry").json()
    assert [p["name"] for p in pantry if p["expiring"]] == ["Espinaca"]


def test_autoplan_varies_and_shopping_list(client):
    client.post("/api/recipes", json=arroz_con_pollo())
    client.post("/api/recipes", json={
        "name": "Sopa de lentejas", "meal_types": ["almuerzo", "cena"], "dish_type": "sopa",
        "servings": 4, "ingredients": [
            {"name": "Lentejas", "quantity": 250, "unit": "g"},
            {"name": "Zanahoria", "quantity": 1, "unit": "unidad"},
        ],
    })
    client.put("/api/settings", json={"household_size": 4})
    client.post("/api/pantry", json={"name": "zanahoria", "quantity": 2, "unit": "unidad"})

    plan = client.post("/api/menu/autoplan", json={
        "start": MONDAY.isoformat(), "days": 2, "meal_types": ["almuerzo", "cena"],
    }).json()
    assert len(plan) == 4
    # no repite la misma receta en dos comidas seguidas cuando hay alternativas
    assert plan[0]["recipe"]["id"] != plan[1]["recipe"]["id"]

    # una segunda corrida no pisa lo ya planeado
    again = client.post("/api/menu/autoplan", json={"start": MONDAY.isoformat(), "days": 2}).json()
    assert again == []

    shopping = {i["name"]: i for i in client.get(
        "/api/shopping-list", params={"start": MONDAY.isoformat(), "days": 2}
    ).json()}
    # 2 arroces con pollo (4 porciones) = 1 kg arroz, 2 kg pollo; 2 sopas = 500 g lentejas
    assert (shopping["Arroz"]["quantity"], shopping["Arroz"]["unit"]) == (1.0, "kg")
    assert (shopping["Pechuga de pollo"]["quantity"], shopping["Pechuga de pollo"]["unit"]) == (2.0, "kg")
    assert (shopping["Lentejas"]["quantity"], shopping["Lentejas"]["unit"]) == (500.0, "g")
    # zanahoria: 2+2+1+1 = 6 necesarias, hay 2 -> comprar 4
    assert shopping["Zanahorias"]["quantity"] == 4
    assert "Cilantro" not in shopping  # opcional


def test_cooking_deducts_pantry(client):
    r = client.post("/api/recipes", json=arroz_con_pollo()).json()
    client.post("/api/pantry/bulk", json=[
        {"name": "arroz", "quantity": 1, "unit": "kg"},
        {"name": "pechuga de pollo", "quantity": 2, "unit": "kg"},
    ])
    entry = client.post("/api/menu", json={
        "day": MONDAY.isoformat(), "meal_type": "almuerzo", "recipe_id": r["id"], "servings": 2,
    }).json()
    res = client.post(f"/api/menu/{entry['id']}/cook").json()
    changes = {c["name"]: c["after"] for c in res["pantry_changes"]}
    assert changes == {"Arroz": 0.75, "Pechuga de pollo": 1.5}
    assert client.post(f"/api/menu/{entry['id']}/cook").status_code == 409
    # recién cocinada: baja en sugerencias frente a una que no se ha hecho
    client.post("/api/recipes", json={**arroz_con_pollo(), "name": "Arroz con pollo 2"})
    sugg = client.get("/api/suggestions", params={"meal_type": "almuerzo"}).json()
    assert sugg[0]["recipe"]["name"] == "Arroz con pollo 2"


def test_invalid_meal_type_rejected(client):
    res = client.post("/api/recipes", json=arroz_con_pollo(meal_types=["brunch"]))
    assert res.status_code == 422


def test_scan_pantry_uses_household_names(client, monkeypatch):
    client.post("/api/recipes", json=arroz_con_pollo())
    seen = {}

    def fake_detect(data, media_type, known):
        seen["known"] = known
        return vision.PantryDetection(notes="", items=[
            vision.DetectedItem(name="Zanahorias", quantity=3, unit="unidad", category="verduras", confidence="alta"),
            vision.DetectedItem(name="Leche", quantity=1, unit="l", category="lácteos y huevos", confidence="media"),
        ])

    monkeypatch.setattr(vision, "detect_pantry", fake_detect)
    res = client.post("/api/pantry/scan", files={"photo": ("nevera.jpg", b"123", "image/jpeg")})
    assert res.status_code == 200
    assert "Pechuga de pollo" in seen["known"]
    known = {i["name"]: i["known"] for i in res.json()["items"]}
    assert known == {"Zanahorias": True, "Leche": False}


def test_scan_without_credentials_gives_clear_error(client, monkeypatch):
    def boom(*a, **kw):
        raise vision.VisionError("Falta configurar ANTHROPIC_API_KEY", 503)

    monkeypatch.setattr(vision, "detect_pantry", boom)
    res = client.post("/api/pantry/scan", files={"photo": ("x.jpg", b"1", "image/jpeg")})
    assert res.status_code == 503
    assert "ANTHROPIC_API_KEY" in res.json()["detail"]


def test_image_validation():
    with pytest.raises(vision.VisionError):
        vision._image_block(b"x", "application/pdf")


def test_index_served(client):
    assert client.get("/").status_code == 200


def test_equivalences_compare_cups_with_kilos(client):
    r = client.post("/api/recipes", json={
        "name": "Arroz blanco", "meal_types": ["almuerzo"], "servings": 4,
        "ingredients": [{"name": "Arroz", "quantity": 2, "unit": "taza"}],
    }).json()
    item = client.post("/api/pantry", json={"name": "arroz", "quantity": 1, "unit": "kg"}).json()
    status = client.get(f"/api/recipes/{r['id']}").json()["availability"]["items"][0]["status"]
    assert status == "hay"  # sin equivalencia no se sabe si alcanza

    res = client.patch(f"/api/ingredients/{item['ingredient_id']}", json={"g_per_cup": 200})
    assert res.status_code == 200
    detail = client.get(f"/api/recipes/{r['id']}", params={"servings": 12}).json()
    arroz = detail["availability"]["items"][0]
    assert (arroz["status"], arroz["missing"]) == ("poco", 1.0)  # 6 tazas = 1.2 kg, hay 1 kg

    client.post("/api/menu", json={
        "day": MONDAY.isoformat(), "meal_type": "almuerzo", "recipe_id": r["id"], "servings": 12,
    })
    shopping = client.get("/api/shopping-list", params={"start": MONDAY.isoformat()}).json()
    assert [(i["name"], i["quantity"], i["unit"]) for i in shopping] == [("Arroz", 200.0, "g")]

    entry = client.get("/api/menu", params={"start": MONDAY.isoformat()}).json()[0]
    changes = client.post(f"/api/menu/{entry['id']}/cook").json()["pantry_changes"]
    assert changes[0]["after"] == 0  # descontó en kg aunque la receta está en tazas

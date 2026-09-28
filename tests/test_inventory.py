from app import clock

TODAY = clock.today()


def _group(data, key):
    return next(g for g in data["groups"] if g["key"] == key)


def test_inventory_groups_items_by_family_categories(client):
    client.post("/api/pantry/bulk", json=[
        {"name": "Pechuga de pollo", "quantity": 1, "unit": "kg", "category": "carnes"},
        {"name": "Tilapia", "quantity": 2, "unit": "unidad", "category": "pescados"},
        {"name": "Lentejas", "quantity": 500, "unit": "g", "category": "legumbres"},
        {"name": "Leche", "quantity": 0, "unit": "l", "category": "lácteos y huevos"},
    ])
    data = client.get("/api/inventory").json()
    assert [g["key"] for g in data["groups"]][:3] == ["proteinas", "lacteos", "verduras"]
    assert {i["name"] for i in _group(data, "proteinas")["items"]} == {"Pechuga de pollo", "Tilapia"}
    assert [i["name"] for i in _group(data, "granos")["items"]] == ["Lentejas"]
    lacteos = _group(data, "lacteos")
    assert (lacteos["count"], lacteos["out"]) == (0, 1)
    assert data["reviewed_on"] is None and data["due"] is True


def test_review_group_updates_pantry_and_shopping_list(client):
    items = client.post("/api/pantry/bulk", json=[
        {"name": "Pollo", "quantity": 1, "unit": "kg", "category": "carnes"},
        {"name": "Carne molida", "quantity": 500, "unit": "g", "category": "carnes"},
        {"name": "Salmón", "quantity": 2, "unit": "unidad", "category": "pescados"},
        {"name": "Queso", "quantity": 1, "unit": "unidad", "category": "lácteos y huevos"},
    ]).json()
    ids = {i["name"]: i["id"] for i in items}

    res = client.post("/api/inventory/proteinas/review", json={"items": [
        {"id": ids["Pollo"], "state": "ok", "quantity": 2},
        {"id": ids["Carne molida"], "state": "out"},
        {"id": ids["Salmón"], "state": "low"},
        {"id": ids["Queso"], "state": "out"},  # es de otro grupo: no se toca
    ]})
    assert res.status_code == 200
    assert sorted(res.json()["to_list"]) == ["Carne molida", "Salmón"]

    pantry = {p["name"]: p for p in client.get("/api/pantry").json()}
    assert pantry["Pollo"]["quantity"] == 2
    assert pantry["Carne molida"]["quantity"] == 0
    assert pantry["Salmón"]["quantity"] == 2
    assert pantry["Queso"]["quantity"] == 1

    shopping = client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()
    assert {i["name"] for i in shopping if i["reason"] == "anotado"} == {"Carne molida", "Salmón"}

    data = client.get("/api/inventory").json()
    prot = _group(data, "proteinas")
    assert prot["reviewed_today"] is True
    assert {i["name"] for i in prot["items"] if i["in_list"]} == {"Carne molida", "Salmón"}
    assert _group(data, "lacteos")["reviewed_today"] is False
    assert data["reviewed_on"] == TODAY.isoformat() and data["due"] is False
    assert client.get("/api/today").json()["inventory"]["days_ago"] == 0

    # Volvieron a comprar salmón: al marcar que hay, sale de la lista (sin repetirse nada).
    client.post("/api/inventory/proteinas/review", json={"items": [
        {"id": ids["Salmón"], "state": "ok"},
        {"id": ids["Carne molida"], "state": "out"},
    ]})
    shopping = client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()
    assert [i["name"] for i in shopping if i["reason"] == "anotado"] == ["Carne molida"]


def test_review_unknown_group(client):
    assert client.post("/api/inventory/nada/review", json={"items": []}).status_code == 404

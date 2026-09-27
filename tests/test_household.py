import datetime as dt

from sqlalchemy import create_engine as sa_create_engine
from sqlalchemy import inspect, text

from app import auth, vision
from app.db import init_db

TODAY = dt.date.today()


def test_chores_rotate_and_undo(client):
    ana = client.post("/api/members", json={"name": "Ana", "emoji": "👩"}).json()
    juan = client.post("/api/members", json={"name": "Juan", "emoji": "👨"}).json()
    chore = client.post("/api/chores", json={
        "name": "Sacar la basura", "emoji": "🗑️", "every_days": 2, "rotate": True,
    }).json()

    [c] = client.get("/api/chores").json()
    assert c["is_due"] and c["turn"]["name"] == "Ana"

    [c] = client.post(f"/api/chores/{chore['id']}/done", json={"member_id": ana["id"]}).json()
    assert not c["is_due"] and c["done_today"]
    assert c["turn"]["name"] == "Juan"  # ahora le toca al siguiente
    assert c["due_on"] == (TODAY + dt.timedelta(days=2)).isoformat()

    # un toque por error se deshace
    [c] = client.post(f"/api/chores/{chore['id']}/undo").json()
    assert c["is_due"] and c["last_done"] is None and c["turn"]["name"] == "Ana"

    client.post(f"/api/chores/{chore['id']}/done", json={"member_id": juan["id"]})
    stats = {s["name"]: s["done"] for s in client.get("/api/chores/stats").json()}
    assert stats == {"Ana": 0, "Juan": 1}


def test_fixed_member_and_bad_member(client):
    ana = client.post("/api/members", json={"name": "Ana"}).json()
    client.post("/api/chores", json={"name": "Regar", "member_id": ana["id"]})
    assert client.get("/api/chores").json()[0]["turn"]["name"] == "Ana"
    assert client.post("/api/chores", json={"name": "X", "member_id": 999}).status_code == 422
    client.delete(f"/api/members/{ana['id']}")
    assert client.get("/api/chores").json()[0]["turn"] is None


def test_low_stock_and_ran_out_go_to_shopping_list(client):
    client.post("/api/pantry", json={"name": "leche", "quantity": 1, "unit": "l", "min_quantity": 2})
    client.post("/api/pantry", json={"name": "huevo", "quantity": 20, "unit": "unidad", "min_quantity": 6})
    client.post("/api/shopping/ran-out", json={"name": "Huevos"})
    client.post("/api/shopping/extra", json={"name": "pilas AA"})
    client.post("/api/shopping/extra", json={"name": "Pilas aa"})  # no se duplica

    items = client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()
    got = {(i["name"], i["reason"]) for i in items}
    assert got == {("Leche", "se acaba"), ("Huevo", "se acaba"), ("Huevo", "anotado"),
                   ("Pilas AA", "anotado")}
    leche = next(i for i in items if i["name"] == "Leche")
    assert (leche["quantity"], leche["unit"]) == (1, "l")

    # al comprar huevos se tachan solos de lo anotado
    client.post("/api/pantry/bulk", json=[{"name": "huevos", "quantity": 30, "unit": "unidad"}])
    items = client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()
    assert {i["name"] for i in items} == {"Leche", "Pilas AA"}


def test_receipt_scan_and_save(client, monkeypatch):
    client.post("/api/recipes", json={
        "name": "Arroz", "meal_types": ["almuerzo"], "servings": 4,
        "ingredients": [{"name": "Arroz", "quantity": 500, "unit": "g"}],
    })
    client.post("/api/shopping/extra", json={"name": "Detergente"})
    seen = {}

    def fake_scan(images, known):
        seen["n"], seen["known"] = len(images), known
        return vision.Receipt(store="Éxito", date="2026-09-26", total=45900, notes="", items=[
            vision.ReceiptLine(raw_text="ARROZ DIANA 1000G", name="Arroz", quantity=1000, unit="g",
                               category="granos y harinas", price=4900, kind="alimento"),
            vision.ReceiptLine(raw_text="DETERG LIQ 2L", name="Detergente", quantity=2, unit="l",
                               category="aseo y limpieza", price=31000, kind="hogar"),
            vision.ReceiptLine(raw_text="BOLSA", name="Bolsa", quantity=1, unit="unidad",
                               category="rara", price=100, kind="otro"),
        ])

    monkeypatch.setattr(vision, "scan_receipt", fake_scan)
    res = client.post("/api/receipts/scan", files=[
        ("photos", ("a.jpg", b"1", "image/jpeg")), ("photos", ("b.jpg", b"2", "image/jpeg")),
    ])
    assert res.status_code == 200
    draft = res.json()
    assert seen["n"] == 2 and "Arroz" in seen["known"]
    assert draft["day"] == "2026-09-26"
    assert [(i["name"], i["keep"], i["known"]) for i in draft["items"]] == [
        ("Arroz", True, True), ("Detergente", True, False), ("Bolsa", False, False)]
    assert draft["items"][2]["category"] == "otros"

    keep = [i for i in draft["items"] if i["keep"]]
    saved = client.post("/api/receipts", json={
        "store": draft["store"], "day": draft["day"], "total": draft["total"], "items": keep,
    })
    assert saved.status_code == 201 and saved.json()["added"] == 2
    pantry = {p["name"]: (p["quantity"], p["unit"]) for p in client.get("/api/pantry").json()}
    assert pantry == {"Arroz": (1000, "g"), "Detergente": (2, "l")}
    # el detergente anotado en la lista se tachó solo
    assert client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json() == []
    spend = client.get("/api/purchases").json()
    assert spend["recent"][0]["store"] == "Éxito" and spend["recent"][0]["items"] == 2


def test_today_summary(client):
    r = client.post("/api/recipes", json={
        "name": "Huevos pericos", "meal_types": ["desayuno"], "servings": 2,
        "ingredients": [{"name": "Huevo", "quantity": 4, "unit": "unidad"}],
    }).json()
    client.post("/api/menu", json={"day": TODAY.isoformat(), "meal_type": "desayuno", "recipe_id": r["id"]})
    client.post("/api/pantry", json={"name": "tomate", "quantity": 2, "unit": "unidad",
                                     "expires_on": TODAY.isoformat()})
    client.post("/api/chores", json={"name": "Barrer"})
    t = client.get("/api/today").json()
    assert t["meals"][0]["recipe"]["name"] == "Huevos pericos"
    assert t["meals"][0]["missing"] == ["Huevo"]
    assert t["expiring"] == [{"name": "Tomate", "days_left": 0}]
    assert [c["name"] for c in t["chores"]] == ["Barrer"]


def test_pin_protects_api(client, monkeypatch):
    monkeypatch.setenv("MYCHEF_PIN", "2580")
    auth._fails.clear()
    assert client.get("/api/auth").json() == {"pin_required": True}
    assert client.get("/api/today").status_code == 401
    assert client.get("/").status_code == 200  # la pantalla carga y pide el PIN
    assert client.post("/api/login", json={"pin": "1111"}).status_code == 401
    assert client.post("/api/login", json={"pin": "2580"}).status_code == 200
    assert client.get("/api/today").status_code == 200  # la cookie queda guardada


def test_old_database_gets_new_columns(tmp_path):
    engine = sa_create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE pantryitem (id INTEGER PRIMARY KEY, ingredient_id INTEGER, "
            "quantity FLOAT, unit VARCHAR, expires_on DATE, updated_at DATETIME)"
        ))
    init_db(engine)
    cols = {c["name"] for c in inspect(engine).get_columns("pantryitem")}
    assert "min_quantity" in cols


def test_house_name_setting(client):
    assert client.get("/api/meta").json()["house_name"] == "Nuestra casa"
    res = client.put("/api/settings", json={"house_name": "Casa Ávila"}).json()
    assert res == {"household_size": 4, "house_name": "Casa Ávila", "wake_word": "Oye casa", "inventory_mode": "normal"}
    client.put("/api/settings", json={"household_size": 5})
    meta = client.get("/api/meta").json()
    assert (meta["house_name"], meta["household_size"]) == ("Casa Ávila", 5)


PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)


def test_family_photos(client, tmp_path, monkeypatch):
    from app import db
    monkeypatch.setattr(db, "PHOTOS_DIR", tmp_path / "photos")
    assert client.get("/api/photos").json() == []
    bad = client.post("/api/photos", files={"photo": ("x.gif", b"GIF89a", "image/gif")})
    assert bad.status_code == 400
    res = client.post("/api/photos", files={"photo": ("fam.png", PNG_1PX, "image/png")}, data={"caption": "Navidad"})
    assert res.status_code == 201
    photo = res.json()
    assert photo["caption"] == "Navidad"
    got = client.get(photo["url"])
    assert got.status_code == 200 and got.content == PNG_1PX
    assert len(list((tmp_path / "photos").iterdir())) == 1
    assert client.delete(f"/api/photos/{photo['id']}").status_code == 204
    assert client.get(photo["url"]).status_code == 404
    assert list((tmp_path / "photos").iterdir()) == []


def test_wake_word_setting(client):
    assert client.get("/api/meta").json()["wake_word"] == "Oye casa"
    assert client.put("/api/settings", json={"wake_word": "  Oye   Lupita "}).json()["wake_word"] == "Oye Lupita"
    assert client.get("/api/meta").json()["wake_word"] == "Oye Lupita"
    assert client.put("/api/settings", json={"wake_word": "a"}).status_code == 422

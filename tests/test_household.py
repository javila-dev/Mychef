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

    def fake_scan(images, known, model=None):
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
    res.pop("ai")
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


def test_chore_calendar_schedules():
    from app import household
    from app.models import Chore

    # Basura: lunes y jueves. Creada un miércoles (2026-09-23) → toca el jueves 24.
    basura = Chore(name="Sacar la basura", schedule="weekdays", weekdays="0,3", created_on=dt.date(2026, 9, 23))
    assert household.due_date(basura) == dt.date(2026, 9, 24)
    assert household.when_text(basura) == "Los lunes y jueves"
    basura.last_done = dt.date(2026, 9, 24)  # hecha el jueves → el lunes siguiente
    assert household.due_date(basura) == dt.date(2026, 9, 28)

    # Día 31 de cada mes: en septiembre (30 días) toca el 30
    pago = Chore(name="Pagar el agua", schedule="monthday", month_day=31, created_on=dt.date(2026, 9, 2))
    assert household.due_date(pago) == dt.date(2026, 9, 30)
    pago.last_done = dt.date(2026, 9, 30)
    assert household.due_date(pago) == dt.date(2026, 10, 31)
    assert household.when_text(pago) == "El 31 de cada mes"

    assert household.when_text(Chore(name="x", schedule="weekdays", weekdays="5,6")) == "Los fines de semana"
    assert household.when_text(Chore(name="x", schedule="weekdays", weekdays="6")) == "Los domingos"
    assert household.due_text(dt.date(2026, 10, 1), dt.date(2026, 9, 28)) == "el jueves"
    assert household.due_text(dt.date(2026, 9, 29), dt.date(2026, 9, 28)) == "mañana"


def test_chore_api_schedule_and_reminders(client):
    from app import clock

    papa = client.post("/api/members", json={"name": "Papá"}).json()
    today = clock.today()
    res = client.post("/api/chores", json={
        "name": "Sacar la basura", "schedule": "weekdays", "weekdays": [today.weekday()],
        "member_id": papa["id"], "remind_at": "19:30",
    })
    assert res.status_code == 201
    chore = next(c for c in client.get("/api/chores").json() if c["name"] == "Sacar la basura")
    assert chore["weekdays"] == [today.weekday()] and chore["remind_at"] == "19:30" and chore["is_due"]

    rem = client.get("/api/reminders").json()
    assert [r["say"] for r in rem["items"]] == ["Recordatorio: sacar la basura. Hoy le toca a Papá."]
    client.post(f"/api/chores/{chore['id']}/done", json={"member_id": papa["id"]})
    assert client.get("/api/reminders").json()["items"] == []

    assert client.post("/api/chores", json={"name": "x", "schedule": "weekdays", "weekdays": []}).status_code == 422
    assert client.post("/api/chores", json={"name": "x", "remind_at": "25:00"}).status_code == 422


def test_ai_models_are_chosen_in_settings(client, monkeypatch):
    from app import ai

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    meta = client.get("/api/meta").json()["ai"]
    assert meta["photo"]["provider"] == "Gemini" and meta["photo"]["configured"] is False
    assert meta["text"]["provider"] == "OpenAI" and meta["text"]["model"] == ai.DEFAULT_TEXT_MODEL

    res = client.put("/api/settings", json={"ai_photo_model": "models/gemini-2.5-pro", "ai_text_model": "gpt-5"})
    assert res.json()["ai"]["photo"]["model"] == "gemini-2.5-pro"  # sin el prefijo "models/"
    assert res.json()["ai"]["text"]["model"] == "gpt-5"
    assert client.put("/api/settings", json={"ai_text_model": "gpt 5; rm -rf"}).status_code == 422

    # Sin clave: aviso claro, sin llamar a nadie
    r = client.post("/api/ai/test", json={"role": "photo"})
    assert r.status_code == 503 and "GEMINI_API_KEY" in r.json()["detail"]
    assert client.get("/api/ai/models", params={"role": "text"}).json() == {"models": []}

    # El escaneo usa el modelo elegido
    seen = {}

    def fake_detect(images, known, place="nevera", model=None):
        seen["model"] = model
        return vision.PantryDetection(notes="", items=[])

    monkeypatch.setattr(vision, "detect_pantry", fake_detect)
    client.post("/api/pantry/scan", files={"photo": ("n.jpg", b"1", "image/jpeg")})
    assert seen["model"] == "gemini-2.5-pro"


def test_ai_providers_map_errors(monkeypatch):
    from app import ai

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    class FakeResponses:
        def parse(self, **kw):
            raise ai.openai.NotFoundError("no", response=__import__("httpx2").Response(404, request=__import__("httpx2").Request("POST", "http://x")), body=None)

    class FakeClient:
        def __init__(self, **kw):
            self.responses = FakeResponses()

    monkeypatch.setattr(ai.openai, "OpenAI", FakeClient)
    try:
        ai.openai_parse("gpt-inexistente", "hola", ai._Ping)
    except ai.AIError as e:
        assert e.status == 400 and "gpt-inexistente" in str(e)
    else:
        raise AssertionError("debía fallar")

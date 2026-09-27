import datetime as dt

import pytest

from app import vision, voice

TODAY = dt.date.today()


@pytest.fixture(autouse=True)
def no_claude(monkeypatch):
    monkeypatch.setattr(vision, "voice_canonical", lambda *a, **k: None)


def say(client, text, **context):
    res = client.post("/api/voice", json={"text": text, "context": context})
    assert res.status_code == 200
    return res.json()


def seed(client):
    client.post("/api/recipes", json={
        "name": "Sopa de lentejas", "meal_types": ["almuerzo", "cena"], "servings": 4,
        "instructions": "1. Remojar las lentejas.\n2. Cocinar con papa.",
        "ingredients": [
            {"name": "Lentejas", "quantity": 500, "unit": "g"},
            {"name": "Papa", "quantity": 2, "unit": "unidad"},
            {"name": "Sal", "quantity": 1, "unit": "cdta"},
        ],
    })
    client.post("/api/pantry", json={"name": "leche", "quantity": 2, "unit": "l"})
    client.post("/api/members", json={"name": "Sofi"})
    client.post("/api/chores", json={"name": "Sacar la basura", "every_days": 2})
    client.post("/api/chores", json={"name": "Regar las plantas", "every_days": 3})


@pytest.mark.parametrize("text,seconds,label", [
    ("pon un temporizador de diez minutos para el arroz", 600, "Arroz"),
    ("Oye casa, temporizador de 5 minutos", 300, ""),
    ("avísame en media hora", 1800, ""),
    ("alarma de una hora y media para el pernil", 5400, "Pernil"),
    ("pon 90 segundos", 90, ""),
    ("temporizador de treinta y cinco minutos", 2100, ""),
])
def test_timers(client, text, seconds, label):
    r = say(client, text)
    assert r["intent"] == "timer_set"
    assert (r["data"]["seconds"], r["data"]["label"]) == (seconds, label)


def test_timer_keeps_article_when_speaking(client):
    r = say(client, "temporizador de 3 segundos para las arepas")
    assert r["speak"] == "Listo, temporizador de 3 segundos para las arepas."
    assert r["data"]["said"] == "las arepas" and r["data"]["label"] == "Arepas"


def test_timer_other_intents(client):
    assert say(client, "cancela el temporizador")["intent"] == "timer_cancel"
    assert say(client, "¿cuánto falta?")["intent"] == "timer_query"
    assert say(client, "pon una alarma")["intent"] == "timer_ask"


def test_ran_out_and_undo_steps(client):
    seed(client)
    r = say(client, "Se acabó la leche y los huevos")
    assert r["intent"] == "ran_out"
    assert r["data"]["items"] == ["Leche", "Huevos"]
    pantry = {p["name"]: p["quantity"] for p in client.get("/api/pantry").json()}
    assert pantry["Leche"] == 0
    names = {i["name"] for i in client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json()}
    assert {"Leche", "Huevos"} <= names
    # deshacer: ejecutar los pasos que devolvió
    for step in r["undo"]["steps"]:
        client.request(step["method"], step["url"], json=step.get("json"))
    pantry = {p["name"]: p["quantity"] for p in client.get("/api/pantry").json()}
    assert pantry["Leche"] == 2
    assert client.get("/api/shopping-list", params={"start": TODAY.isoformat()}).json() == []


@pytest.mark.parametrize("text,items", [
    ("agrega pan a la lista", ["Pan"]),
    ("anota jabón, papel higiénico y pilas", ["Jabón", "Papel higiénico", "Pilas"]),
    ("necesitamos arepas", ["Arepas"]),
    ("hay que comprar café por favor", ["Café"]),
])
def test_add_to_list(client, text, items):
    r = say(client, text)
    assert r["intent"] == "list_add"
    assert r["data"]["items"] == items


def test_add_uses_household_names(client):
    seed(client)
    r = say(client, "apunta lenteja")
    assert r["data"]["items"] == ["Lentejas"]


def test_chore_done_with_person(client):
    seed(client)
    r = say(client, "Sofi ya sacó la basura")
    assert r["intent"] == "chore_done"
    assert r["data"]["chore"] == "Sacar la basura"
    chore = next(c for c in client.get("/api/chores").json() if c["name"] == "Sacar la basura")
    assert chore["done_today"] and chore["last_done_by"]["name"] == "Sofi"
    r2 = say(client, "ya regué las plantas")
    assert r2["data"]["chore"] == "Regar las plantas"


def test_menu_and_summaries(client):
    seed(client)
    rid = client.get("/api/recipes").json()[0]["id"]
    client.post("/api/menu", json={"day": TODAY.isoformat(), "meal_type": "almuerzo", "recipe_id": rid})
    r = say(client, "¿Qué hay de almuerzo?")
    assert r["intent"] == "menu_today" and "sopa de lentejas" in r["speak"]
    assert say(client, "qué vamos a cenar")["speak"].startswith("No hay nada planeado de cena")
    r = say(client, "qué falta comprar")
    assert r["intent"] == "shopping" and r["speak"].startswith("Faltan")
    assert say(client, "qué tareas hay")["intent"] == "chores"
    r = say(client, "qué cocino")
    assert r["intent"] == "what" and r["navigate"]["screen"] == "what"


def test_open_recipe_and_cook_mode(client):
    seed(client)
    r = say(client, "abre la receta de lentejas")
    assert r["intent"] == "open_recipe" and r["navigate"]["screen"] == "cook"
    rid = r["navigate"]["recipeId"]
    ctx = {"screen": "cook", "recipe_id": rid, "servings": 8}
    assert say(client, "siguiente", **ctx)["intent"] == "step_next"
    assert say(client, "anterior", **ctx)["intent"] == "step_prev"
    assert say(client, "repite por favor", **ctx)["intent"] == "step_repeat"
    q = say(client, "¿cuántas lentejas lleva?", **ctx)
    assert q["speak"] == "Lleva 1000 gramos de lentejas."  # escalado a 8 personas
    assert say(client, "cuánta sal", **ctx)["speak"] == "Lleva 2 cucharaditas de sal."
    assert say(client, "cuánto pollo lleva", **ctx)["speak"] == "La receta no lleva pollo."
    assert say(client, "qué ingredientes lleva", **ctx)["intent"] == "ingredients"
    # "siguiente" fuera de la receta no es un paso
    assert say(client, "siguiente")["intent"] == "unknown"


def test_navigation_help_and_unknown(client):
    assert say(client, "volver al inicio")["navigate"] == {"screen": "home"}
    assert say(client, "escanear factura")["navigate"] == {"screen": "receipt"}
    assert say(client, "escanea la nevera")["navigate"] == {"screen": "fridge", "place": "nevera"}
    assert say(client, "tómale una foto a la alacena")["navigate"] == {"screen": "fridge", "place": "alacena"}
    assert say(client, "ayuda")["intent"] == "help"
    r = say(client, "blablá tralalá")
    assert r["intent"] == "unknown" and "Pueden decir" in r["speak"]


def test_claude_fallback_rewrites_to_known_command(client, monkeypatch):
    seed(client)
    monkeypatch.setattr(vision, "voice_canonical", lambda text, *a: "agrega queso a la lista")
    r = say(client, "ay no, acuérdate de que nos quedamos sin quesito")
    assert r["intent"] == "list_add" and r["data"]["items"] == ["Queso"]
    assert r["data"]["understood_as"] == "agrega queso a la lista"


def test_parse_duration_unit():
    assert voice.parse_duration("un cuarto de hora") == 900
    assert voice.parse_duration("minuto y medio") is None


def test_handsfree_never_calls_claude(client, monkeypatch):
    calls = []
    monkeypatch.setattr(vision, "voice_canonical", lambda *a: calls.append(a) or "agrega queso")
    r = say(client, "paso uno remojar las lentejas", screen="cook", handsfree=True)
    assert r["intent"] == "unknown" and calls == []

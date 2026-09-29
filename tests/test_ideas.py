"""Ideas nuevas de la IA para el menú del domingo: la proteína manda, solo con lo que hay y de prueba."""

import datetime as dt
import re

from app import ai
from app.ideas import Idea, IdeaIngredient, Ideas

START = dt.date(2026, 10, 5)  # lunes
MON, TUE = START.isoformat(), (START + dt.timedelta(days=1)).isoformat()


def stock(client, *items):
    for name, q, unit, cat in items:
        assert client.post("/api/pantry", json={"name": name, "quantity": q, "unit": unit, "category": cat}).status_code == 201


def fake_ai(monkeypatch, prompts, fail=()):
    """La IA de mentiras: una receta por comida del pedido (y la ensalada en el almuerzo)."""
    monkeypatch.setattr(ai, "ready", lambda session, role: True)

    def parse(model, prompt, schema, fast=False):
        prompts.append(prompt)
        meal = re.search(r"para cada una de estas comidas \((\w+)\)", prompt).group(1)
        if meal in fail:
            raise ai.AIError("OpenAI no dio una respuesta válida.", 422)
        ideas = []
        for n, protein in re.findall(r"^(\d+)\. .*?(?:proteína: (\w+))?$", prompt, re.M):
            main = protein or "Huevo"
            ideas.append(Idea(slot=int(n), kind="main", name=f"{main} de la IA {n}", dish_type="plato principal",
                              prep_minutes=30, steps=["Picar", "Cocinar"], ingredients=[
                                  IdeaIngredient(name=main, quantity=500, unit="g", category="carnes", to_buy=False),
                                  IdeaIngredient(name="Arroz", quantity=300, unit="g", category="granos y harinas", to_buy=False),
                                  IdeaIngredient(name="Cilantro", quantity=1, unit="unidad", category="verduras", to_buy=True)]))
            if meal == "almuerzo":
                ideas.append(Idea(slot=int(n), kind="salad", name=f"Ensalada {n}", dish_type="plato principal",
                                  prep_minutes=10, steps=["Picar"], ingredients=[
                                      IdeaIngredient(name="Tomate", quantity=2, unit="unidad", category="verduras", to_buy=False)]))
        ideas.append(Idea(slot=99, kind="main", name="Fuera de lugar", dish_type="sopa", prep_minutes=5, steps=[],
                          ingredients=[IdeaIngredient(name="Agua", quantity=1, unit="l", category="bebidas", to_buy=False)]))
        return Ideas(ideas=ideas)
    monkeypatch.setattr(ai, "text_parse", parse)


def ask(client, slots, **kw):
    return client.post("/api/menu/ideas", json={"start": MON, "slots": [{"day": d, "meal": m} for d, m in slots], **kw})


def test_proteins_are_assigned_before_asking(client, monkeypatch):
    stock(client, ("Pollo", 600, "g", "carnes"), ("Carne de res", 600, "g", "carnes"),
          ("Lentejas", 300, "g", "legumbres"), ("Huevo", 12, "unidad", "lácteos y huevos"))
    prompts = []
    fake_ai(monkeypatch, prompts)
    r = ask(client, [(MON, "almuerzo"), (MON, "cena"), (TUE, "almuerzo"), (TUE, "cena")])
    assert r.status_code == 200, r.text
    got = [s["protein"] for s in r.json()["slots"]]
    # Cada una alcanza para una comida de 4; el huevo no cuenta para almuerzo y cena
    assert sorted(got[:3]) == ["Carne de res", "Lentejas", "Pollo"] and got[3] is None
    assert got[0] != got[1] and got[2] != got[3]
    assert any("no alcanza lo que hay" in p for p in prompts)


def test_ideas_use_the_house_profile_and_pantry(client, monkeypatch):
    client.put("/api/taste", json={"city": "Medellín", "stores": ["D1"], "summary": "- No comen hígado"})
    client.post("/api/recipes", json={"name": "Arroz con pollo", "ingredients": []})
    stock(client, ("Pollo", 1, "kg", "carnes"), ("Tomate", 4, "unidad", "verduras"), ("Arroz", 1, "kg", "granos y harinas"))
    prompts = []
    fake_ai(monkeypatch, prompts)
    r = ask(client, [(MON, "almuerzo"), (MON, "desayuno")], avoid=["Pollo de la IA 0"]).json()
    assert len(prompts) == 2  # un pedido por comida, en paralelo
    lunch_prompt = next(p for p in prompts if "(almuerzo)" in p)
    for text in ("Medellín", "D1", "No comen hígado", "Pollo (1 kg)", "sal", "Arroz con pollo", "ensalada"):
        assert text in lunch_prompt
    lunch, breakfast = r["slots"]
    # «Pollo de la IA 0» ya la vieron (botón «Otra»): no se repite
    assert lunch["main"] is None and lunch["salad"]["recipe"]["name"] == "Ensalada 0"
    assert lunch["salad"]["recipe"]["dish_type"] == "ensalada" and lunch["salad"]["can_cook"]
    main = breakfast["main"]
    assert main["ai"] and main["recipe"]["id"] is None and "salad" not in breakfast
    assert (main["protein"], main["starch"]) == ("Huevo", "Arroz")
    assert [m["name"] for m in main["missing"]] == ["Huevo", "Cilantro"]  # lo que hay que comprar
    assert main["draft"]["instructions"] == "1. Picar\n2. Cocinar"
    assert r["errors"] == []


def test_one_meal_failing_does_not_break_the_rest(client, monkeypatch):
    prompts = []
    fake_ai(monkeypatch, prompts, fail=("cena",))
    r = ask(client, [(MON, "almuerzo"), (MON, "cena")]).json()
    assert r["slots"][0]["main"] and r["slots"][1]["main"] is None
    assert r["errors"] and r["errors"][0].startswith("cena")

    fake_ai(monkeypatch, prompts, fail=("cena",))
    assert ask(client, [(MON, "cena")]).status_code == 502


def test_without_ai_key(client, monkeypatch):
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "MYCHEF_MENU_MODEL"):
        monkeypatch.delenv(key, raising=False)
    r = ask(client, [(MON, "almuerzo")])
    assert r.status_code == 503 and "GEMINI_API_KEY" in r.json()["detail"]
    client.put("/api/settings", json={"ai_menu_model": "gpt-5-mini"})
    assert "OPENAI_API_KEY" in ask(client, [(MON, "almuerzo")]).json()["detail"]


def test_saved_ideas_are_trial_recipes(client, monkeypatch):
    stock(client, ("Pollo", 1, "kg", "carnes"))
    fake_ai(monkeypatch, [])
    lunch = ask(client, [(MON, "almuerzo")]).json()["slots"][0]
    entries = [{"day": MON, "meal_type": "almuerzo", "new_recipe": lunch["main"]["draft"]},
               {"day": MON, "meal_type": "almuerzo", "new_recipe": lunch["salad"]["draft"]},
               {"day": TUE, "meal_type": "almuerzo", "new_recipe": lunch["main"]["draft"]}]
    r = client.post("/api/menu/week", json={"entries": entries})
    assert r.status_code == 201, r.text
    saved = r.json()
    assert all(e["recipe"]["trial"] for e in saved)
    assert saved[0]["recipe"]["id"] == saved[2]["recipe"]["id"]  # la misma idea dos veces: una sola receta
    assert saved[1]["recipe"]["dish_type"] == "ensalada"
    # De prueba: no cuentan como recetas de la casa para planear ni sugerir
    plan = client.post("/api/menu/plan", json={"start": (START + dt.timedelta(days=7)).isoformat(),
                                               "slots": [{"day": (START + dt.timedelta(days=7)).isoformat(), "meal": "almuerzo"}]}).json()
    assert plan["slots"][0]["main"] is None
    assert client.get("/api/suggestions?meal_type=almuerzo").json() == []
    recipe = client.get(f"/api/recipes/{saved[0]['recipe']['id']}").json()
    assert recipe["trial"] and [i["name"] for i in recipe["ingredients"]] == ["Pollo", "Arroz", "Cilantro"]
    assert client.post("/api/menu/week", json={"entries": [{"day": MON, "meal_type": "almuerzo"}]}).status_code == 422


def test_did_they_like_it(client, monkeypatch):
    stock(client, ("Pollo", 1, "kg", "carnes"))
    fake_ai(monkeypatch, [])
    lunch = ask(client, [(MON, "almuerzo")]).json()["slots"][0]
    saved = client.post("/api/menu/week", json={"entries": [
        {"day": MON, "meal_type": "almuerzo", "new_recipe": lunch["main"]["draft"]},
        {"day": MON, "meal_type": "almuerzo", "new_recipe": lunch["salad"]["draft"]}]}).json()
    good, bad = saved[0]["recipe"]["id"], saved[1]["recipe"]["id"]

    # ¡Sí! pasa a las recetas de la casa: ya cuenta para armar el menú
    r = client.post(f"/api/recipes/{good}/verdict", json={"verdict": "yes"}).json()
    assert (r["trial"], r["disliked"]) == (False, False)
    assert [s["recipe"]["id"] for s in client.get("/api/suggestions?meal_type=almuerzo").json()] == [good]

    # No nos gustó: sigue de prueba y la IA no la vuelve a proponer
    r = client.post(f"/api/recipes/{bad}/verdict", json={"verdict": "no"}).json()
    assert (r["trial"], r["disliked"]) == (True, True)
    prompts = []
    fake_ai(monkeypatch, prompts)
    ask(client, [(TUE, "almuerzo")])
    prompt = prompts[0]
    avoid = prompt.split("NO debes repetir")[1].split("\n")[0]
    assert "Ensalada 0" in avoid
    assert "que sí les gustaron: Pollo de la IA 0" in prompt and "NO les gustaron (no propongas nada parecido): Ensalada 0" in prompt

    # Más o menos: queda de prueba, sin marca
    r = client.post(f"/api/recipes/{bad}/verdict", json={"verdict": "meh"}).json()
    assert (r["trial"], r["disliked"]) == (True, False)
    assert client.post(f"/api/recipes/{bad}/verdict", json={"verdict": "tal vez"}).status_code == 422

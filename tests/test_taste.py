"""Cómo comemos: dónde viven, el cuestionario de la IA y el resumen que se puede corregir a mano."""

from app import ai, taste
from app.taste import TasteQuestion, TasteQuestions, TasteSummary


def _ai_returns(monkeypatch, result, seen=None):
    def fake(model, prompt, schema, fast=False):
        if seen is not None:
            seen.append(prompt)
        return result
    monkeypatch.setattr(ai, "text_parse", fake)


def test_empty_profile(client):
    t = client.get("/api/taste").json()
    assert t["city"] == "" and t["summary"] == "" and t["adventure"] == "fija"
    assert "D1" in t["stores_options"] and len(t["adventure_options"]) == 3


def test_where_and_adventure_are_saved(client):
    t = client.put("/api/taste", json={"city": " Medellín ", "area": "Laureles",
                                       "stores": ["D1", "D1", " Plaza de mercado ", ""], "adventure": "explorar"}).json()
    assert (t["city"], t["area"], t["adventure"]) == ("Medellín", "Laureles", "explorar")
    assert t["stores"] == ["D1", "Plaza de mercado"]
    # Lo que no se manda se queda como estaba
    t = client.put("/api/taste", json={"adventure": "mezcla"}).json()
    assert t["city"] == "Medellín" and t["stores"] == ["D1", "Plaza de mercado"]
    assert client.put("/api/taste", json={"adventure": "loco"}).status_code == 422


def test_summary_edited_by_hand_becomes_bullets(client):
    t = client.put("/api/taste", json={"summary": "No comen hígado\n\n• Poco picante\n- Benja ama la pasta"}).json()
    assert t["summary"] == "- No comen hígado\n- Poco picante\n- Benja ama la pasta"
    assert t["updated_on"]


def test_questions_read_the_house_recipes(client, monkeypatch):
    client.put("/api/taste", json={"city": "Medellín", "stores": ["D1"]})
    client.post("/api/recipes", json={"name": "Arroz con pollo", "meal_types": ["almuerzo"], "ingredients": [
        {"name": "pollo", "quantity": 500, "category": "carnes"}, {"name": "sal", "quantity": 5}]})
    seen = []
    _ai_returns(monkeypatch, TasteQuestions(questions=[
        TasteQuestion(text="¿Qué no se come en la casa?", options=["Hígado", "Pescado", "Hígado", " "], multiple=True),
        TasteQuestion(text="¿Qué no se come en la casa?", options=["Repetida", "Otra"], multiple=False),
        TasteQuestion(text="¿Picante?", options=["Nada"], multiple=False),  # una sola opción: no sirve
        TasteQuestion(text="¿Cuánto tiempo hay para cocinar entre semana?", options=["30 min", "1 hora"], multiple=False),
    ]), seen)
    qs = client.post("/api/taste/questions").json()["questions"]
    assert [q["text"] for q in qs] == ["¿Qué no se come en la casa?", "¿Cuánto tiempo hay para cocinar entre semana?"]
    assert qs[0]["options"] == ["Hígado", "Pescado"] and qs[0]["multiple"]
    # La IA ve las recetas de la casa (sin los básicos) y dónde viven
    assert "Arroz con pollo [almuerzo; plato principal]: Pollo" in seen[0] and "Medellín" in seen[0] and "D1" in seen[0]


def test_questions_error_is_explained(client, monkeypatch):
    def boom(model, prompt, schema, fast=False):
        raise ai.AIError("Falta configurar OPENAI_API_KEY para usar OpenAI.", 503)
    monkeypatch.setattr(ai, "text_parse", boom)
    r = client.post("/api/taste/questions")
    assert r.status_code == 503 and "OPENAI_API_KEY" in r.json()["detail"]

    _ai_returns(monkeypatch, TasteQuestions(questions=[]))
    assert client.post("/api/taste/questions").status_code == 422


def test_summary_from_answers(client, monkeypatch):
    seen = []
    _ai_returns(monkeypatch, TasteSummary(summary="* No comen hígado\n* Cenas livianas"), seen)
    t = client.post("/api/taste/summary", json={"answers": [
        {"question": "¿Qué no se come?", "answer": "Hígado"},
        {"question": "¿Picante?", "answer": "  "},  # sin responder: no se manda
    ]}).json()
    assert t["summary"] == "- No comen hígado\n- Cenas livianas"
    assert t["answers"] == [{"question": "¿Qué no se come?", "answer": "Hígado"}]
    assert "Hígado" in seen[0] and "¿Picante?" not in seen[0]

    r = client.post("/api/taste/summary", json={"answers": [{"question": "¿Picante?", "answer": ""}]})
    assert r.status_code == 422


def test_context_for_recipe_ideas(client):
    from app.db import get_session
    from app.main import app

    client.put("/api/taste", json={"city": "Medellín", "area": "Belén", "stores": ["Tienda de barrio"],
                                   "summary": "- No comen hígado", "adventure": "explorar"})
    session = next(app.dependency_overrides[get_session]())
    text = taste.context(session)
    assert "Belén, Medellín" in text and "Tienda de barrio" in text
    assert "No comen hígado" in text and "Explorar sabores nuevos" in text

"""Cómo comemos: lo que la IA sabe de la cocina de la casa antes de proponer recetas.

Dónde viven y dónde compran (para no pedir cosas que no se consiguen), un resumen de gustos que sale
de un cuestionario hecho por la IA (y que la familia puede corregir a mano) y qué tanto quieren que
las ideas nuevas se arriesguen: ir a la fija o explorar sabores nuevos.
"""

from __future__ import annotations

import json
import re
from typing import Literal

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from . import ai, clock
from .models import Member, Recipe, Setting

SETTING_KEY = "taste_profile"

ADVENTURE = {
    "fija": "Ir a la fija: platos conocidos de la cocina casera colombiana, parecidos a los que ya hacen.",
    "mezcla": "Un poco de todo: sobre todo platos conocidos, de vez en cuando algo distinto.",
    "explorar": "Explorar sabores nuevos: platos de otras cocinas o preparaciones distintas, "
                "pero siempre con ingredientes que se consiguen fácil donde viven.",
}
STORES = ["Tienda de barrio", "D1", "Ara", "Éxito", "Carulla", "Olímpica", "Plaza de mercado"]

EMPTY = {"city": "", "area": "", "stores": [], "adventure": "fija", "summary": "",
         "answers": [], "updated_on": None}

MAX_RECIPES = 80  # las que se le muestran a la IA para que no pregunte lo que ya se ve


def _clean(s: str, n: int) -> str:
    return re.sub(r"\s+", " ", s or "").strip()[:n]


def get(session: Session) -> dict:
    s = session.get(Setting, SETTING_KEY)
    try:
        data = json.loads(s.value) if s else {}
    except ValueError:
        data = {}
    out = {**EMPTY, **{k: v for k, v in data.items() if k in EMPTY}}
    if out["adventure"] not in ADVENTURE:
        out["adventure"] = "fija"
    return out


def save(session: Session, **changes) -> dict:
    data = {**get(session), **changes}
    session.merge(Setting(key=SETTING_KEY, value=json.dumps(data, ensure_ascii=False)))
    session.commit()
    return data


def out(session: Session) -> dict:
    return {**get(session), "ai_ready": ai.ready(session, "menu"), "stores_options": STORES,
            "adventure_options": [{"key": k, "text": t} for k, t in ADVENTURE.items()]}


# ---------------------------------------------------------------- lo que la IA sabe de la casa

def _where(p: dict) -> str:
    place = ", ".join(x for x in (p["area"], p["city"]) if x) or "Colombia"
    stores = ", ".join(p["stores"])
    return f"Viven en {place}." + (f" Compran en: {stores}." if stores else "")


def _people(session: Session) -> str:
    from . import services

    adults, kids = services.household_size(session), services.household_kids(session)
    names = [f"{m.name}{' (niño/a)' if m.kid else ''}" for m in session.exec(select(Member))]
    return f"En la casa comen {adults} adultos y {kids} niños." + (f" Personas: {', '.join(names)}." if names else "")


def _recipes(session: Session) -> str:
    lines = []
    house = select(Recipe).where(Recipe.trial == False).order_by(Recipe.favorite.desc(), Recipe.name)  # noqa: E712
    for r in session.exec(house).all()[:MAX_RECIPES]:
        main = [ri.ingredient.name for ri in r.ingredients if not ri.ingredient.is_staple][:8]
        fav = " (favorita)" if r.favorite else ""
        lines.append(f"- {r.name}{fav} [{r.meal_types}; {r.dish_type}]: {', '.join(main)}")
    return "\n".join(lines) or "(todavía no han guardado recetas)"


def context(session: Session) -> str:
    """Lo que va en cada pedido de recetas a la IA: dónde viven, cómo comen y qué tanto arriesgar."""
    p = get(session)
    parts = [_where(p), _people(session)]
    if p["summary"]:
        parts.append(f"Cómo comen (lo dijo la familia):\n{p['summary']}")
    # Lo que ya probaron de las ideas nuevas: para aprender de sus gustos
    ideas = session.exec(select(Recipe).where(Recipe.ai_idea == True)).all()  # noqa: E712
    liked = [r.name for r in ideas if not r.trial and not r.disliked][:20]
    disliked = [r.name for r in ideas if r.disliked][:20]
    if liked:
        parts.append(f"Ideas nuevas que sí les gustaron: {', '.join(liked)}.")
    if disliked:
        parts.append(f"Ideas nuevas que NO les gustaron (no propongas nada parecido): {', '.join(disliked)}.")
    parts.append(ADVENTURE[p["adventure"]])
    return "\n".join(parts)


# ---------------------------------------------------------------- el cuestionario

class TasteQuestion(BaseModel):
    text: str = Field(description="La pregunta, corta y en español de Colombia, tratando de 'ustedes'")
    options: list[str] = Field(description="De 2 a 6 respuestas cortas para tocar")
    multiple: bool = Field(description="true si se puede elegir más de una respuesta")


class TasteQuestions(BaseModel):
    questions: list[TasteQuestion]


class TasteSummary(BaseModel):
    summary: str = Field(description="Viñetas cortas que empiezan con '- ', una idea por línea")


def questions(session: Session) -> list[dict]:
    p = get(session)
    prompt = f"""Eres quien ayuda a una familia colombiana a planear el menú de la semana. Antes de \
proponerles recetas quieres conocer cómo comen. {_where(p)} {_people(session)}
Estas son las recetas que ya tienen guardadas:
<recetas>
{_recipes(session)}
</recetas>
Haz entre 8 y 10 preguntas para conocer sus gustos. Reglas:
- No preguntes lo que ya se ve en las recetas: úsalas para preguntar mejor (p. ej. si casi no hay pescado, \
pregunta si es porque no les gusta).
- Pregunta por lo que sirve para proponer platos: qué no se come en la casa o les cae mal, alergias, \
picante, carnes y pescados que prefieren, cuánto tiempo hay para cocinar entre semana, con qué cocinan \
(olla a presión, horno, freidora de aire), qué les gusta a los niños, qué comen en el desayuno, qué no \
quieren en la cena.
- Cada pregunta con 2 a 6 respuestas cortas para tocar; la persona también puede escribir otra.
- Palabras sencillas, sin tecnicismos; trata a la familia de "ustedes"."""
    result = ai.text_parse(ai.model_for(session, "menu"), prompt, TasteQuestions)
    seen, qs = set(), []
    for q in result.questions:
        text = _clean(q.text, 160)
        opts = list(dict.fromkeys(o for o in (_clean(o, 60) for o in q.options) if o))[:6]
        if text and len(opts) >= 2 and text.lower() not in seen:
            seen.add(text.lower())
            qs.append({"text": text, "options": opts, "multiple": bool(q.multiple)})
    if not qs:
        raise ai.AIError("La IA no devolvió preguntas; intenten de nuevo.", 422)
    return qs[:12]


class Answer(BaseModel):
    question: str = Field(max_length=200)
    answer: str = Field(max_length=400)


def summarize(session: Session, answers: list[Answer]) -> dict:
    answered = [a for a in answers if _clean(a.answer, 400)]
    if not answered:
        raise ai.AIError("Respondan al menos una pregunta.", 422)
    qa = "\n".join(f"- {_clean(a.question, 200)} → {_clean(a.answer, 400)}" for a in answered)
    p = get(session)
    prompt = f"""Una familia colombiana respondió un cuestionario sobre cómo come. {_where(p)} {_people(session)}
Sus recetas guardadas:
<recetas>
{_recipes(session)}
</recetas>
Sus respuestas:
<respuestas>
{qa}
</respuestas>
Escribe un resumen de cómo comen, para usarlo después al proponerles recetas. Entre 6 y 12 viñetas \
cortas que empiezan con "- ", una idea por línea: lo que no comen o les cae mal (primero), lo que les \
gusta, desayunos, cenas, niños, tiempo y utensilios. Solo lo que dijeron o se ve en las recetas; no \
inventes. Español sencillo."""
    result = ai.text_parse(ai.model_for(session, "menu"), prompt, TasteSummary)
    summary = _summary_text(result.summary)
    if not summary:
        raise ai.AIError("La IA no devolvió el resumen; intenten de nuevo.", 422)
    return save(session, summary=summary, updated_on=clock.today().isoformat(),
                answers=[{"question": _clean(a.question, 200), "answer": _clean(a.answer, 400)} for a in answered])


def _summary_text(text: str) -> str:
    lines = [re.sub(r"^[-•*\s]+", "", ln).strip() for ln in (text or "").splitlines()]
    return "\n".join(f"- {ln}" for ln in lines if ln)[:3000]


class TasteIn(BaseModel):
    city: str | None = Field(None, max_length=60)
    area: str | None = Field(None, max_length=60)
    stores: list[str] | None = Field(None, max_length=12)
    adventure: Literal["fija", "mezcla", "explorar"] | None = None
    summary: str | None = Field(None, max_length=3000)


def update(session: Session, data: TasteIn) -> dict:
    changes = {}
    if data.city is not None:
        changes["city"] = _clean(data.city, 60)
    if data.area is not None:
        changes["area"] = _clean(data.area, 60)
    if data.stores is not None:
        changes["stores"] = list(dict.fromkeys(s for s in (_clean(s, 40) for s in data.stores) if s))
    if data.adventure is not None:
        changes["adventure"] = data.adventure
    if data.summary is not None:
        changes["summary"] = _summary_text(data.summary)
        changes["updated_on"] = clock.today().isoformat()
    return save(session, **changes)

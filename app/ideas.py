"""Ideas nuevas para el menú del domingo: recetas que propone la IA con lo que hay en la casa.

Todo gira alrededor de la proteína. Antes de preguntarle a la IA, aquí se reparten las proteínas que
hay entre los almuerzos y las cenas de la semana (lo que se vence primero, sin repetir la misma el
mismo día ni dos días seguidos): así la IA no pone pollo cinco días ni se le olvida la carne que se
va a dañar. La harina se usa si la hay, y solo se pide lo que hay, los básicos de la cocina o cosas
fáciles de conseguir en la tienda donde viven la familia.

Se le pregunta a la IA por tipo de comida, en paralelo, para que no tarde. Lo que devuelve son
borradores: no se guarda nada hasta que la familia aprueba la semana, y entonces quedan como recetas
de prueba (`Recipe.trial`) hasta que digan que les gustó.
"""

from __future__ import annotations

import datetime as dt
import logging
import math
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from . import ai, planner, services, taste
from .models import (
    DISH_TYPES, INGREDIENT_CATEGORIES, STAPLE_NAMES, Ingredient, Recipe, RecipeIngredient, ingredient_key,
)
from .units import normalize_unit, to_grams

log = logging.getLogger(__name__)

WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
# Cuánto rinde la proteína: gramos crudos por porción de adulto (los granos, secos).
PORTION_GRAMS = {"carnes": 150, "pescados": 150, "legumbres": 70}
MAX_TO_BUY = 2  # cosas para comprar por receta
GROUPS = {  # un pedido a la IA por grupo, en paralelo
    "desayuno": ["desayuno"], "almuerzo": ["almuerzo"], "cena": ["cena"], "merienda": ["merienda"],
}
MEAL_RULES = {
    "desayuno": "Desayuno colombiano de casa (arepa, huevos, calentado, pan, changua, caldo…). Aquí el huevo "
                "sí puede ser la proteína.",
    "almuerzo": "Almuerzo: plato fuerte alrededor de la proteína indicada, con harina si la hay, Y ADEMÁS una "
                "ensalada sencilla aparte (kind = \"salad\") con verduras que haya, aliñada con limón, sal, aceite "
                "o vinagre. La ensalada no repite la harina del plato fuerte.",
    "cena": "Cena: plato fuerte alrededor de la proteína indicada. NADA de desayuno en la cena (ni arepa con "
            "huevo, ni pericos, ni calentado, ni changua). El huevo solo si va mezclado en un plato de verdad "
            "(atún con huevo, tortilla española).",
    "merienda": "Merienda sencilla para niños: fruta, algo horneado fácil, un batido, galletas caseras. Porción de niño.",
}


# ---------------------------------------------------------------- las proteínas de la semana

def _available_proteins(session: Session, pantry: services.Pantry, start: dt.date) -> list[dict]:
    """Proteínas que hay (sin el huevo), lo que se vence primero, con cuántos gramos quedan."""
    out = []
    for iid, s in pantry.items():
        if s.quantity <= 0:
            continue
        ing = session.get(Ingredient, iid)
        if ing is None or ing.category not in planner.PROTEIN_CATEGORIES:
            continue
        grams = to_grams(s.quantity, s.unit, ing.g_per_ml, ing.g_per_unit)
        days = (s.expires_on - start).days if s.expires_on else 99
        out.append({"key": ing.key, "name": ing.name, "category": ing.category, "grams": grams, "days": days,
                    "portions": s.quantity if normalize_unit(s.unit) == services.PORTION else None})
    out.sort(key=lambda p: (p["days"], -(p["grams"] or 0)))
    return out


def assign_proteins(session: Session, slots: list[dict], start: dt.date) -> dict[tuple[str, str], str | None]:
    """(día, comida) -> proteína para cada almuerzo y cena; None = no alcanza lo que hay (se compra una)."""
    proteins = _available_proteins(session, services.load_pantry(session), start)
    left = {p["key"]: (p["grams"], p["portions"]) for p in proteins}
    used_on: dict[str, set[str]] = {}  # día -> proteínas
    uses: dict[str, int] = {}
    out: dict[tuple[str, str], str | None] = {}
    for s in sorted(slots, key=lambda s: (s["day"], services.MEAL_ORDER.get(s["meal"], 9))):
        if s["meal"] not in ("almuerzo", "cena"):
            continue
        eaten = s["portions"]
        yesterday = (dt.date.fromisoformat(s["day"]) - dt.timedelta(days=1)).isoformat()

        def enough(p):
            grams, portions = left[p["key"]]
            if portions is not None:
                return portions >= eaten * 0.75
            return grams is None or grams >= PORTION_GRAMS[p["category"]] * eaten * 0.75

        options = [p for p in proteins if enough(p) and p["key"] not in used_on.get(s["day"], set())]
        options.sort(key=lambda p: (p["key"] in used_on.get(yesterday, set()), uses.get(p["key"], 0), p["days"]))
        pick = options[0] if options else None
        out[(s["day"], s["meal"])] = pick["name"] if pick else None
        if pick:
            grams, portions = left[pick["key"]]
            left[pick["key"]] = (
                None if grams is None else grams - PORTION_GRAMS[pick["category"]] * eaten,
                None if portions is None else portions - eaten,
            )
            if grams is None and portions is None:
                left[pick["key"]] = (0, None)  # sin saber cuánto hay: alcanza para una comida
            used_on.setdefault(s["day"], set()).add(pick["key"])
            uses[pick["key"]] = uses.get(pick["key"], 0) + 1
    return out


# ---------------------------------------------------------------- lo que devuelve la IA

class IdeaIngredient(BaseModel):
    name: str = Field(description="Nombre corto del ingrediente, en español de Colombia")
    quantity: float = Field(description="Cantidad para las porciones pedidas")
    unit: str = Field(description="g, kg, ml, l, unidad, taza, cda, cdta, lb, paquete o lata")
    category: Literal[tuple(INGREDIENT_CATEGORIES)]  # type: ignore[valid-type]
    to_buy: bool = Field(description="true si NO está en lo que hay ni en los básicos (hay que comprarlo)")


class Idea(BaseModel):
    slot: int = Field(description="El número de la comida a la que corresponde")
    kind: Literal["main", "salad"]
    name: str
    dish_type: Literal[tuple(DISH_TYPES)]  # type: ignore[valid-type]
    prep_minutes: int
    ingredients: list[IdeaIngredient]
    steps: list[str] = Field(description="De 3 a 7 pasos cortos")


class Ideas(BaseModel):
    ideas: list[Idea]


# ---------------------------------------------------------------- el pedido

def _pantry_text(session: Session, pantry: services.Pantry, start: dt.date) -> str:
    by_cat: dict[str, list[str]] = {}
    for iid, s in pantry.items():
        if s.quantity <= 0:
            continue
        ing = session.get(Ingredient, iid)
        if ing is None or ing.is_staple:
            continue
        soon = s.expires_on and (s.expires_on - start).days <= services.EXPIRING_DAYS
        by_cat.setdefault(ing.category, []).append(
            f"{ing.name} ({s.quantity:g} {s.unit}){' — se vence pronto' if soon else ''}")
    return "\n".join(f"- {cat}: {', '.join(sorted(items))}" for cat, items in sorted(by_cat.items())) or "(casi nada)"


def _staples_text(session: Session) -> str:
    marked = [i.name.lower() for i in session.exec(select(Ingredient).where(Ingredient.staple == True))]  # noqa: E712
    return ", ".join(dict.fromkeys(STAPLE_NAMES + marked))


def _slot_line(n: int, s: dict, protein: str | None) -> str:
    day = dt.date.fromisoformat(s["day"])
    who = f"{s['adults']} adultos y {s['kids']} niños" if s["kids"] else f"{s['adults']} adultos"
    line = f"{n}. {WEEKDAYS[day.weekday()]} {day.day} · {s['meal']} · {who} (= {s['portions']:g} porciones de adulto)"
    if s["meal"] in ("almuerzo", "cena"):
        line += f" · proteína: {protein}" if protein else " · proteína: no alcanza lo que hay; propón una fácil de conseguir (to_buy)"
    return line


def build_prompt(context: str, pantry: str, staples: str, avoid: list[str], meal: str, lines: list[str]) -> str:
    return f"""Eres quien le ayuda a una familia colombiana a armar el menú de la semana con lo que tienen en la casa.
<familia>
{context}
</familia>
Lo que hay en la nevera y la alacena:
<hay>
{pantry}
</hay>
Básicos que siempre hay (no se compran): {staples}.
Recetas que NO debes repetir (ya las tienen o las comieron la semana pasada): {", ".join(avoid) or "ninguna"}.

Propón una receta para cada una de estas comidas ({meal}):
{chr(10).join(lines)}

Reglas:
- {MEAL_RULES[meal]}
- Todo gira alrededor de la proteína indicada; usa la harina que haya (arroz, papa, plátano, yuca, arepa, pasta…).
- Solo ingredientes de lo que hay, de los básicos o fáciles de conseguir en una tienda de barrio o supermercado \
de donde viven. Nada de especias raras ni productos importados. Máximo {MAX_TO_BUY} cosas para comprar por receta, \
marcadas con to_buy = true.
- Ten en cuenta cómo come la familia (lo que no comen es sagrado).
- Cantidades para las porciones de cada comida. Nombres como se dicen en Colombia.
- Sin repetir plato en la semana y variando la preparación (sudado, asado, guisado, al horno…).
- slot = el número de la comida. Una receta por comida (kind = "main") y, solo en el almuerzo, además su ensalada."""


def _ask(prompt: str, model: str) -> Ideas:
    return ai.text_parse(model, prompt, Ideas)


# ---------------------------------------------------------------- borradores

def draft_recipe(session: Session, idea: Idea, meal: str, portions: float) -> Recipe:
    """Una receta sin guardar, para ver qué hay y qué falta (y guardarla después si la aprueban)."""
    recipe = Recipe(name=idea.name.strip()[:80], meal_types=meal, dish_type=idea.dish_type,
                    servings=max(1, math.ceil(portions)), prep_minutes=max(0, idea.prep_minutes) or None,
                    instructions="\n".join(f"{n}. {s.strip()}" for n, s in enumerate(idea.steps, 1) if s.strip()),
                    trial=True)
    lines = []
    for i in idea.ingredients:
        if not i.name.strip() or i.quantity < 0:
            continue
        ing = session.exec(select(Ingredient).where(Ingredient.key == ingredient_key(i.name))).first()
        ing = ing or Ingredient(name=i.name.strip().capitalize(), key=ingredient_key(i.name), category=i.category)
        lines.append(RecipeIngredient(ingredient=ing, ingredient_id=ing.id, quantity=i.quantity, unit=normalize_unit(i.unit)))
    recipe.ingredients = lines
    if recipe in session:
        session.expunge(recipe)
    return recipe


def _out(session: Session, idea: Idea, meal: str, portions: float, pantry: services.Pantry, expiring: set[int]) -> dict:
    recipe = draft_recipe(session, idea, meal, portions)
    avail = services.check_availability(recipe, portions, pantry)
    cand = planner._candidate(recipe, avail, 0, False, expiring, 0)
    cand["recipe"] = {**cand["recipe"], "id": None}
    cand["ai"] = True
    cand["draft"] = {
        "name": recipe.name, "meal_types": [meal], "dish_type": recipe.dish_type, "servings": recipe.servings,
        "prep_minutes": recipe.prep_minutes, "instructions": recipe.instructions,
        "ingredients": [{"name": i.name.strip(), "quantity": i.quantity, "unit": normalize_unit(i.unit),
                         "category": i.category} for i in idea.ingredients if i.name.strip() and i.quantity >= 0],
    }
    return cand


def propose(session: Session, start: dt.date, slots: list[dict], avoid: list[str] | None = None) -> dict:
    """slots = [{day, meal, adults, kids}]. Devuelve una idea por comida (y la ensalada del almuerzo)."""
    if not ai.ready(session, "menu"):
        key = ai.KEY_ENV[ai.provider_of(ai.model_for(session, "menu"))]
        raise ai.AIError(f"Para las ideas nuevas falta configurar la IA ({key}).", 503)
    for s in slots:
        s["portions"] = services.portions(session, s["adults"], s["kids"])
    proteins = assign_proteins(session, slots, start)
    pantry = services.load_pantry(session)
    expiring = {iid for iid, s in pantry.items()
                if s.expires_on and s.quantity > 0 and (s.expires_on - start).days <= services.EXPIRING_DAYS}
    recent = planner.recent_recipes(session, start)
    names = [r.name for r in session.exec(select(Recipe).where(Recipe.trial == False))]  # noqa: E712
    names += [session.get(Recipe, rid).name for rid in recent if session.get(Recipe, rid)]
    names = list(dict.fromkeys(names + list(avoid or [])))[:120]
    context, pantry_txt, staples = taste.context(session), _pantry_text(session, pantry, start), _staples_text(session)
    model = ai.model_for(session, "menu")

    jobs = {}
    for group, meals in GROUPS.items():
        mine = [(n, s) for n, s in enumerate(slots) if s["meal"] in meals]
        if mine:
            lines = [_slot_line(n, s, proteins.get((s["day"], s["meal"]))) for n, s in mine]
            jobs[group] = build_prompt(context, pantry_txt, staples, names, group, lines)

    results: dict[str, Ideas] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=len(jobs) or 1) as pool:
        futures = {g: pool.submit(_ask, p, model) for g, p in jobs.items()}
        for g, f in futures.items():
            try:
                results[g] = f.result()
            except ai.AIError as e:
                log.warning("La IA no pudo con las ideas de %s: %s", g, e)
                errors.append(f"{g}: {e}")
    if not results and errors:
        raise ai.AIError(errors[0].split(": ", 1)[1], 502)

    out = [{"day": s["day"], "meal": s["meal"], "adults": s["adults"], "kids": s["kids"],
            "protein": proteins.get((s["day"], s["meal"])), "main": None,
            **({"salad": None} if s["meal"] == planner.SALAD_MEAL else {})} for s in slots]
    seen: set[str] = {n.lower() for n in names}
    for ideas in results.values():
        for idea in ideas.ideas:
            if not (0 <= idea.slot < len(slots)) or not idea.ingredients or not idea.name.strip():
                continue
            slot, target = slots[idea.slot], out[idea.slot]
            kind = "salad" if idea.kind == "salad" and "salad" in target else "main"
            if target[kind] is not None or idea.name.strip().lower() in seen:
                continue  # una por comida, y nada repetido
            if kind == "salad":
                idea.dish_type = "ensalada"
            seen.add(idea.name.strip().lower())
            target[kind] = _out(session, idea, slot["meal"], slot["portions"], pantry, expiring)
    return {"slots": out, "errors": errors}

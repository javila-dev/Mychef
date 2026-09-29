"""El menú del domingo: con lo que hay, arma la semana de desayunos, almuerzos, meriendas y cenas.

Todo gira alrededor de la proteína (carnes, pescados y granos; el huevo solo en el desayuno) y de la
harina (arroz, papa, plátano, yuca, arepa, pasta…). Las reglas:
- nada que se haya comido o estado en el menú la semana anterior (si no alcanzan las recetas, se
  repite y se avisa);
- no repetir receta en la semana y repartir las proteínas (no pollo cinco días);
- primero lo que alcanza con lo que hay y lo que se va a vencer;
- el almuerzo lleva ensalada, que no repite la harina del plato ni la ensalada del día anterior.

Aquí solo se propone: nada se guarda hasta que la familia confirma (`save_week`). Cada comida trae
alternativas para cambiarla con un toque y un orden (`ai_rank`) que dice cuáles conviene más
reemplazar por ideas nuevas de la IA: primero las que la casa resuelve peor.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from sqlmodel import Session, select

from . import services
from .models import MEAL_TYPES, CookLog, MenuEntry, Recipe
from .units import to_grams

RECENT_DAYS = 7  # «la semana inmediatamente anterior»
OPTIONS = 6  # alternativas por comida para el botón «Otra»

PROTEIN_CATEGORIES = {"carnes", "pescados", "legumbres"}
# Harinas de la casa colombiana (claves de ingrediente: sin tildes, en singular)
STARCH_KEYS = (
    "arroz", "papa", "platano", "yuca", "arepa", "pasta", "espagueti", "macarron", "fideo", "pan",
    "arracacha", "mazorca", "maiz", "harina", "tortilla", "cuchuco", "quinua", "avena", "ñame", "name",
)
MAIN_DISHES = {"plato principal", "sopa"}
BREAKFAST_DISHES = MAIN_DISHES | {"panadería", "bebida"}
SALAD_MEAL = "almuerzo"


def is_egg(ingredient) -> bool:
    return ingredient.key.startswith("huevo")


def is_starch(ingredient) -> bool:
    # Por palabra completa: «papa criolla» sí, «papaya» no
    return ingredient.category == "granos y harinas" or ingredient.key.split(" ")[0] in STARCH_KEYS


def protein_of(recipe: Recipe):
    """La proteína que manda en el plato (la de más cantidad); el huevo solo si no hay otra."""
    found = [ri for ri in recipe.ingredients if not ri.optional and ri.ingredient.category in PROTEIN_CATEGORIES]
    if not found:
        found = [ri for ri in recipe.ingredients if not ri.optional and is_egg(ri.ingredient)]
    if not found:
        return None
    def grams(ri):
        return to_grams(ri.quantity, ri.unit, ri.ingredient.g_per_ml, ri.ingredient.g_per_unit) or 0
    return max(found, key=grams).ingredient


def starch_of(recipe: Recipe):
    found = [ri for ri in recipe.ingredients if not ri.optional and is_starch(ri.ingredient)]
    return found[0].ingredient if found else None


def fits(recipe: Recipe, meal: str, kind: str) -> bool:
    if meal not in recipe.meal_type_list:
        return False
    if kind == "salad":
        return recipe.dish_type == "ensalada"
    if meal == "merienda":
        return recipe.dish_type != "ensalada"
    return recipe.dish_type in (BREAKFAST_DISHES if meal == "desayuno" else MAIN_DISHES)


def recent_recipes(session: Session, start: dt.date) -> dict[int, dt.date]:
    """Recetas que estuvieron en el menú o se cocinaron la semana antes de `start` -> último día."""
    since = start - dt.timedelta(days=RECENT_DAYS)
    out: dict[int, dt.date] = {}
    rows = [(e.recipe_id, e.day) for e in session.exec(
        select(MenuEntry).where(MenuEntry.day >= since, MenuEntry.day < start))]
    rows += [(c.recipe_id, c.day) for c in session.exec(
        select(CookLog).where(CookLog.day >= since, CookLog.day < start))]
    for rid, day in rows:
        if rid not in out or day > out[rid]:
            out[rid] = day
    return out


@dataclass
class Week:
    """Lo que ya quedó en la semana mientras se arma, para no repetir."""
    used: dict[int, int] = field(default_factory=dict)  # receta -> veces
    proteins: dict[str, int] = field(default_factory=dict)  # proteína -> veces (almuerzos y cenas)
    day_proteins: dict[dt.date, set[str]] = field(default_factory=dict)
    salads: dict[dt.date, int] = field(default_factory=dict)  # día -> receta de ensalada

    def add(self, day: dt.date, meal: str, recipe: Recipe, kind: str) -> None:
        self.used[recipe.id] = self.used.get(recipe.id, 0) + 1
        if kind == "salad":
            self.salads[day] = recipe.id
            return
        p = protein_of(recipe)
        if p and meal in ("almuerzo", "cena"):
            self.proteins[p.key] = self.proteins.get(p.key, 0) + 1
            self.day_proteins.setdefault(day, set()).add(p.key)


def _candidate(recipe: Recipe, avail: dict, score: float, repeat: bool, expiring: set[int], again: int) -> dict:
    p, s = protein_of(recipe), starch_of(recipe)
    return {
        "recipe": services.recipe_summary(recipe),
        "protein": p.name if p else None,
        "starch": s.name if s else None,
        "score": round(score, 1),
        "coverage": avail["coverage"],
        "can_cook": avail["can_cook"],
        "missing": [
            {"name": i["name"], "quantity": i["missing"], "unit": i["unit"]}
            for i in avail["items"] if i["status"] in ("falta", "poco") and not i["optional"]
        ],
        "uses_expiring": sorted(ri.ingredient.name for ri in recipe.ingredients if ri.ingredient_id in expiring),
        "repeat": repeat,  # estuvo la semana pasada: solo se propone si no hay más
        "again": again,  # veces que ya va en esta semana (pocas recetas: se repite y se avisa)
    }


def rank(
    recipes: list[Recipe], day: dt.date, meal: str, kind: str, portions: float,
    pantry: services.Pantry, week: Week, recent: dict[int, dt.date], expiring: set[int],
    main: Recipe | None = None,
) -> list[dict]:
    """Las recetas de la casa para una comida, de la mejor a la peor."""
    out = []
    for recipe in recipes:
        if not fits(recipe, meal, kind):
            continue
        avail = services.check_availability(recipe, portions, pantry)
        repeat = recipe.id in recent
        score = avail["coverage"] * 100
        score += 15 * sum(1 for ri in recipe.ingredients if ri.ingredient_id in expiring)
        score += 10 if recipe.favorite else 0
        score -= 200 if repeat else 0
        score -= 80 * week.used.get(recipe.id, 0)
        if kind == "salad":
            s = starch_of(recipe)
            if s and main is not None and (ms := starch_of(main)) and ms.key == s.key:
                score -= 40  # ensalada de papa con un plato que ya trae papa
            if week.salads.get(day - dt.timedelta(days=1)) == recipe.id:
                score -= 40
        elif meal in ("almuerzo", "cena"):
            p = protein_of(recipe)
            if p:
                score -= 25 * week.proteins.get(p.key, 0)
                if p.key in week.day_proteins.get(day, set()):
                    score -= 30  # la misma proteína al almuerzo y a la cena
                if p.key in week.day_proteins.get(day - dt.timedelta(days=1), set()):
                    score -= 15
                if meal == "cena" and is_egg(p):
                    score -= 50  # el huevo solo, mejor al desayuno
            else:
                score -= 20  # sin proteína no es un plato fuerte
        out.append(_candidate(recipe, avail, score, repeat, expiring, week.used.get(recipe.id, 0)))
    out.sort(key=lambda c: (-c["score"], c["recipe"]["name"]))
    return out


# ---------------------------------------------------------------- la semana

def plan_week(
    session: Session, start: dt.date, slots: list[tuple[dt.date, str]],
    people: dict[tuple[dt.date, str], tuple[int, int]] | None = None, keep_existing: bool = True,
) -> dict:
    """Propone la semana. `slots` = las comidas que se hacen en casa; `people` = quién come si cambia."""
    people = people or {}
    slots = sorted(set(slots), key=lambda s: (s[0], services.MEAL_ORDER.get(s[1], 9)))
    end = max((d for d, _ in slots), default=start)
    recipes = list(session.exec(select(Recipe).where(Recipe.trial == False)))  # noqa: E712 (las de prueba no son de la casa)
    recent = recent_recipes(session, start)
    pantry = services.load_pantry(session)
    expiring = {
        iid for iid, s in pantry.items()
        if s.expires_on and s.quantity > 0 and (s.expires_on - start).days <= services.EXPIRING_DAYS
    }
    week = Week()

    existing: dict[tuple[dt.date, str], list[MenuEntry]] = {}
    if keep_existing:
        for e in session.exec(select(MenuEntry).where(MenuEntry.day >= start, MenuEntry.day <= end)):
            existing.setdefault((e.day, e.meal_type), []).append(e)
    # Lo que ya está en el menú cuenta primero: gasta de la despensa y no se repite.
    for (day, meal), entries in existing.items():
        for e in entries:
            week.add(day, meal, e.recipe, "salad" if e.recipe.dish_type == "ensalada" else "main")
            if not e.cooked:
                services.consume(pantry, e.recipe, services.entry_portions(session, e))

    out = []
    for day, meal in slots:
        adults, kids = people.get((day, meal)) or services.meal_diners(session, meal)
        slot = {"day": day.isoformat(), "meal": meal, "adults": adults, "kids": kids}
        if (day, meal) in existing:
            out.append({**slot, "fixed": True, "entries": [
                {"id": e.id, "recipe": services.recipe_summary(e.recipe), "cooked": e.cooked}
                for e in existing[(day, meal)]]})
            continue
        eaten = services.portions(session, adults, kids)
        mains = rank(recipes, day, meal, "main", eaten, pantry, week, recent, expiring)
        slot.update({"fixed": False, "main": mains[0] if mains else None, "main_options": mains[:OPTIONS]})
        chosen = session.get(Recipe, mains[0]["recipe"]["id"]) if mains else None
        if chosen:
            week.add(day, meal, chosen, "main")
            services.consume(pantry, chosen, eaten)
        if meal == SALAD_MEAL:
            salads = rank(recipes, day, meal, "salad", eaten, pantry, week, recent, expiring, main=chosen)
            slot.update({"salad": salads[0] if salads else None, "salad_options": salads[:OPTIONS]})
            if salads:
                salad = session.get(Recipe, salads[0]["recipe"]["id"])
                week.add(day, meal, salad, "salad")
                services.consume(pantry, salad, eaten)
        out.append(slot)

    _rank_for_ai(out)
    return {"start": start.isoformat(), "slots": out,
            "recent": sorted({services.recipe_summary(r)["name"] for r in recipes if r.id in recent})}


def _rank_for_ai(slots: list[dict]) -> None:
    """ai_rank 1 = la comida que más conviene cambiar por una idea nueva (la casa la resuelve peor).
    Así el slider solo decide cuántas: con «½», las primeras mitad."""
    def weakness(s: dict):
        m = s.get("main")
        if m is None:
            return (0, 0, 0)
        return (1, 0 if m["repeat"] or m["again"] else 1, m["score"])
    free = [s for s in slots if not s["fixed"]]
    for n, s in enumerate(sorted(free, key=weakness), start=1):
        s["ai_rank"] = n


def save_week(session: Session, entries: list[dict], replace: list[tuple[dt.date, str]]) -> list[MenuEntry]:
    """Guarda lo que la familia aprobó. En las comidas de `replace` se quita lo que había sin cocinar."""
    for day, meal in set(replace):
        for e in session.exec(select(MenuEntry).where(MenuEntry.day == day, MenuEntry.meal_type == meal)):
            if not e.cooked:
                session.delete(e)
    created = []
    for item in entries:
        entry = MenuEntry(day=item["day"], meal_type=item["meal_type"], recipe_id=item["recipe_id"],
                          servings=item["servings"], kids=item["kids"])
        session.add(entry)
        created.append(entry)
    session.flush()
    return created


def valid_meal(meal: str) -> bool:
    return meal in MEAL_TYPES

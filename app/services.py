"""Lógica de la casa: escalar recetas, ver qué hay, sugerir, planear y comprar."""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass

from sqlmodel import Session, select

from .models import (
    CookLog,
    Ingredient,
    MenuEntry,
    PantryItem,
    Recipe,
    RecipeIngredient,
    Setting,
    ingredient_key,
    utcnow,
)
from .units import dimension, humanize, normalize_unit, to_base

EXPIRING_DAYS = 3


# ---------------------------------------------------------------- ingredientes

def get_or_create_ingredient(
    session: Session, name: str, category: str | None = None, unit: str | None = None
) -> Ingredient:
    key = ingredient_key(name)
    ing = session.exec(select(Ingredient).where(Ingredient.key == key)).first()
    if ing:
        if category and ing.category == "otros":
            ing.category = category
        return ing
    ing = Ingredient(
        name=name.strip().capitalize(),
        key=key,
        category=category or "otros",
        default_unit=normalize_unit(unit) if unit else "g",
    )
    session.add(ing)
    session.flush()
    return ing


def household_size(session: Session) -> int:
    s = session.get(Setting, "household_size")
    return int(s.value) if s else 4


# ---------------------------------------------------------------- despensa

@dataclass
class Stock:
    quantity: float
    unit: str
    expires_on: dt.date | None


Pantry = dict[int, Stock]


def load_pantry(session: Session) -> Pantry:
    return {
        p.ingredient_id: Stock(p.quantity, p.unit, p.expires_on)
        for p in session.exec(select(PantryItem))
    }


def add_to_pantry(
    session: Session,
    name: str,
    quantity: float,
    unit: str,
    category: str | None = None,
    expires_on: dt.date | None = None,
    replace: bool = False,
) -> PantryItem:
    """Suma (o reemplaza) una cantidad en la despensa, convirtiendo unidades si se puede."""
    unit = normalize_unit(unit)
    ing = get_or_create_ingredient(session, name, category, unit)
    item = session.exec(select(PantryItem).where(PantryItem.ingredient_id == ing.id)).first()
    if item is None:
        item = PantryItem(ingredient_id=ing.id, quantity=quantity, unit=unit, expires_on=expires_on)
    else:
        converted = ing.convert(quantity, unit, item.unit)
        if replace or converted is None:
            item.quantity, item.unit = quantity, unit
        else:
            item.quantity = round(item.quantity + converted, 3)
        if expires_on:
            item.expires_on = expires_on
        item.updated_at = utcnow()
    session.add(item)
    session.flush()
    return item


# ---------------------------------------------------------------- recetas

def scale_factor(recipe: Recipe, servings: int | None) -> float:
    if not servings or recipe.servings <= 0:
        return 1.0
    return servings / recipe.servings


def scaled_ingredients(recipe: Recipe, servings: int | None) -> list[dict]:
    f = scale_factor(recipe, servings)
    return [
        {
            "ingredient_id": ri.ingredient_id,
            "name": ri.ingredient.name,
            "category": ri.ingredient.category,
            "quantity": round(ri.quantity * f, 2),
            "unit": ri.unit,
            "note": ri.note,
            "optional": ri.optional,
        }
        for ri in recipe.ingredients
    ]


def check_availability(recipe: Recipe, servings: int | None, pantry: Pantry) -> dict:
    """Compara lo que pide la receta (escalada) con lo que hay en la despensa."""
    items = []
    required = ok = 0
    for ri, ing in zip(recipe.ingredients, scaled_ingredients(recipe, servings)):
        stock = pantry.get(ing["ingredient_id"])
        entry = {**ing, "have": None, "have_unit": None, "missing": 0.0}
        if stock is None or stock.quantity <= 0:
            entry["status"] = "falta"
            entry["missing"] = ing["quantity"]
        else:
            entry["have"], entry["have_unit"] = round(stock.quantity, 2), stock.unit
            have = ri.ingredient.convert(stock.quantity, stock.unit, ing["unit"])
            if have is None:
                entry["status"] = "hay"  # unidades no comparables: hay algo, sin saber cuánto
            elif have + 1e-9 >= ing["quantity"]:
                entry["status"] = "ok"
            else:
                entry["status"] = "poco"
                entry["missing"] = round(ing["quantity"] - have, 2)
        if not ing["optional"]:
            required += 1
            if entry["status"] in ("ok", "hay"):
                ok += 1
            elif entry["status"] == "poco" and ing["quantity"]:
                ok += 1 - entry["missing"] / ing["quantity"]
        items.append(entry)
    coverage = ok / required if required else 1.0
    missing = [i for i in items if i["status"] in ("falta", "poco") and not i["optional"]]
    return {
        "coverage": round(coverage, 3),
        "can_cook": not missing,
        "missing_count": len(missing),
        "items": items,
    }


def consume(pantry: Pantry, recipe: Recipe, servings: int | None) -> None:
    """Descuenta de una despensa (real o simulada) lo que usa la receta."""
    for ri, ing in zip(recipe.ingredients, scaled_ingredients(recipe, servings)):
        stock = pantry.get(ing["ingredient_id"])
        if stock is None:
            continue
        used = ri.ingredient.convert(ing["quantity"], ing["unit"], stock.unit)
        if used is not None:
            stock.quantity = max(0.0, round(stock.quantity - used, 3))


def last_cooked(session: Session) -> dict[int, dt.date]:
    result: dict[int, dt.date] = {}
    for log in session.exec(select(CookLog)):
        if log.recipe_id not in result or log.day > result[log.recipe_id]:
            result[log.recipe_id] = log.day
    return result


def suggest(
    session: Session,
    meal_type: str | None = None,
    servings: int | None = None,
    dish_type: str | None = None,
    pantry: Pantry | None = None,
    avoid: dict[int, int] | None = None,
    today: dt.date | None = None,
    limit: int = 10,
) -> list[dict]:
    """Ordena las recetas de la casa según lo que hay, lo que vence pronto y la variedad."""
    today = today or dt.date.today()
    pantry = pantry if pantry is not None else load_pantry(session)
    servings = servings or household_size(session)
    avoid = avoid or {}  # receta -> veces ya planeada en el periodo
    cooked = last_cooked(session)
    expiring = {
        iid for iid, s in pantry.items()
        if s.expires_on and s.quantity > 0 and (s.expires_on - today).days <= EXPIRING_DAYS
    }

    ranked = []
    for recipe in session.exec(select(Recipe)):
        if meal_type and meal_type not in recipe.meal_type_list:
            continue
        if dish_type and recipe.dish_type != dish_type:
            continue
        avail = check_availability(recipe, servings, pantry)
        uses_expiring = sorted(
            ri.ingredient.name for ri in recipe.ingredients if ri.ingredient_id in expiring
        )
        last = cooked.get(recipe.id)
        days_since = (today - last).days if last else None
        variety = 1.0 if days_since is None else min(days_since, 30) / 30
        score = avail["coverage"] * 100 + 15 * len(uses_expiring) + 20 * variety
        if recipe.favorite:
            score += 10
        score -= 60 * avoid.get(recipe.id, 0)
        ranked.append({
            "recipe": recipe_summary(recipe),
            "servings": servings,
            "score": round(score, 1),
            "coverage": avail["coverage"],
            "can_cook": avail["can_cook"],
            "missing": [
                {"name": i["name"], "quantity": i["missing"], "unit": i["unit"]}
                for i in avail["items"] if i["status"] in ("falta", "poco") and not i["optional"]
            ],
            "uses_expiring": uses_expiring,
            "last_cooked": last.isoformat() if last else None,
        })
    ranked.sort(key=lambda r: (-r["score"], r["recipe"]["name"]))
    return ranked[:limit]


def cook(session: Session, recipe: Recipe, servings: int, day: dt.date | None = None) -> list[dict]:
    """Registra que se cocinó y descuenta de la despensa real."""
    pantry = load_pantry(session)
    before = {k: v.quantity for k, v in pantry.items()}
    consume(pantry, recipe, servings)
    changes = []
    for item in session.exec(select(PantryItem)):
        new_qty = pantry[item.ingredient_id].quantity
        if new_qty != before[item.ingredient_id]:
            changes.append({
                "name": item.ingredient.name,
                "before": before[item.ingredient_id],
                "after": new_qty,
                "unit": item.unit,
            })
            item.quantity = new_qty
            item.updated_at = utcnow()
            session.add(item)
    session.add(CookLog(recipe_id=recipe.id, servings=servings, day=day or dt.date.today()))
    session.flush()
    return changes


# ---------------------------------------------------------------- menú

def autoplan(
    session: Session,
    start: dt.date,
    days: int,
    meal_types: list[str],
    servings: int | None = None,
    overwrite: bool = False,
) -> list[MenuEntry]:
    """Llena el menú de la semana con recetas de la casa, gastando primero lo que hay."""
    servings = servings or household_size(session)
    end = start + dt.timedelta(days=days - 1)
    existing = session.exec(
        select(MenuEntry).where(MenuEntry.day >= start, MenuEntry.day <= end)
    ).all()
    if overwrite:
        for e in existing:
            if not e.cooked:
                session.delete(e)
        existing = [e for e in existing if e.cooked]
    taken = {(e.day, e.meal_type) for e in existing}
    used: dict[int, int] = {}
    for e in existing:
        used[e.recipe_id] = used.get(e.recipe_id, 0) + 1

    pantry = load_pantry(session)
    for e in existing:
        if not e.cooked:
            consume(pantry, e.recipe, e.servings)

    created = []
    for offset in range(days):
        day = start + dt.timedelta(days=offset)
        for meal in meal_types:
            if (day, meal) in taken:
                continue
            options = suggest(
                session, meal_type=meal, servings=servings, pantry=pantry,
                avoid=used, today=day, limit=1,
            )
            if not options:
                continue
            recipe = session.get(Recipe, options[0]["recipe"]["id"])
            entry = MenuEntry(day=day, meal_type=meal, recipe_id=recipe.id, servings=servings)
            session.add(entry)
            created.append(entry)
            used[recipe.id] = used.get(recipe.id, 0) + 1
            consume(pantry, recipe, servings)
    session.flush()
    return created


def shopping_list(session: Session, start: dt.date, end: dt.date) -> list[dict]:
    """Lo que falta comprar para el menú (no cocinado) entre dos fechas.

    Todo se suma en la unidad en que la casa guarda cada ingrediente (la de la despensa),
    usando sus equivalencias; lo que no se puede convertir queda en una línea aparte.
    """
    entries = session.exec(
        select(MenuEntry).where(
            MenuEntry.day >= start, MenuEntry.day <= end, MenuEntry.cooked == False  # noqa: E712
        )
    ).all()
    pantry = load_pantry(session)
    # (ingredient_id, unidad) -> cantidad necesaria
    needed: dict[tuple[int, str], float] = {}
    info: dict[int, Ingredient] = {}
    used_in: dict[int, set[str]] = {}
    for e in entries:
        for ri, ing in zip(e.recipe.ingredients, scaled_ingredients(e.recipe, e.servings)):
            if ing["optional"] or not ing["quantity"]:
                continue
            iid, ingredient = ing["ingredient_id"], ri.ingredient
            info[iid] = ingredient
            used_in.setdefault(iid, set()).add(e.recipe.name)
            stock = pantry.get(iid)
            qty = ingredient.convert(ing["quantity"], ing["unit"], stock.unit) if stock else None
            if qty is not None:
                key = (iid, normalize_unit(stock.unit))
            else:
                qty, base = to_base(ing["quantity"], ing["unit"])
                key = (iid, base)
            needed[key] = needed.get(key, 0.0) + qty

    result = []
    for (iid, unit), qty in needed.items():
        stock = pantry.get(iid)
        have = 0.0
        if stock and normalize_unit(stock.unit) == unit:
            have = stock.quantity
        missing = qty - have
        if missing <= 1e-9:
            continue
        base_missing, base_unit = to_base(missing, unit)
        base_needed, _ = to_base(qty, unit)
        q, u = humanize(base_missing, base_unit)
        if dimension(u) not in ("masa", "volumen"):
            q = math.ceil(q - 1e-6)  # no se compran 2,3 cebollas
        nq, nu = humanize(base_needed, base_unit)
        ing = info[iid]
        result.append({
            "ingredient_id": iid,
            "name": ing.name,
            "category": ing.category,
            "quantity": q,
            "unit": u,
            "needed_total": nq,
            "needed_unit": nu,
            "recipes": sorted(used_in[iid]),
        })
    result.sort(key=lambda r: (r["category"], r["name"]))
    return result


# ---------------------------------------------------------------- serialización

def recipe_summary(recipe: Recipe) -> dict:
    return {
        "id": recipe.id,
        "name": recipe.name,
        "meal_types": recipe.meal_type_list,
        "dish_type": recipe.dish_type,
        "servings": recipe.servings,
        "prep_minutes": recipe.prep_minutes,
        "favorite": recipe.favorite,
    }


def recipe_detail(recipe: Recipe, servings: int | None = None, pantry: Pantry | None = None) -> dict:
    data = recipe_summary(recipe)
    data.update({
        "instructions": recipe.instructions,
        "notes": recipe.notes,
        "scaled_to": servings or recipe.servings,
        "factor": round(scale_factor(recipe, servings), 3),
        "ingredients": scaled_ingredients(recipe, servings),
    })
    if pantry is not None:
        data["availability"] = check_availability(recipe, servings, pantry)
    return data


def set_recipe_ingredients(session: Session, recipe: Recipe, ingredients: list) -> None:
    for ri in list(recipe.ingredients):
        session.delete(ri)
    recipe.ingredients = []
    session.flush()
    for item in ingredients:
        ing = get_or_create_ingredient(session, item.name, item.category, item.unit)
        recipe.ingredients.append(RecipeIngredient(
            ingredient_id=ing.id,
            quantity=item.quantity,
            unit=normalize_unit(item.unit),
            note=item.note or "",
            optional=item.optional,
        ))

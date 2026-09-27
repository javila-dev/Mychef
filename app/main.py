from __future__ import annotations

import datetime as dt
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from . import services, vision
from .db import get_session, init_db
from .models import (
    DISH_TYPES,
    INGREDIENT_CATEGORIES,
    MEAL_TYPES,
    Ingredient,
    MenuEntry,
    PantryItem,
    Recipe,
    Setting,
    utcnow,
)
from .units import UNITS

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="MyChef", description="El menú de la casa con nuestras recetas", lifespan=lifespan)

SessionDep = Depends(get_session)


# ---------------------------------------------------------------- esquemas

class IngredientLine(BaseModel):
    name: str = Field(min_length=1)
    quantity: float = Field(ge=0)
    unit: str = "g"
    note: str = ""
    optional: bool = False
    category: str | None = None


class RecipeIn(BaseModel):
    name: str = Field(min_length=1)
    meal_types: list[str] = Field(default_factory=lambda: ["almuerzo"])
    dish_type: str = "plato principal"
    servings: int = Field(4, ge=1)
    prep_minutes: int | None = None
    instructions: str = ""
    notes: str = ""
    favorite: bool = False
    ingredients: list[IngredientLine] = Field(default_factory=list)


class PantryIn(BaseModel):
    name: str = Field(min_length=1)
    quantity: float = Field(ge=0)
    unit: str = "g"
    category: str | None = None
    expires_on: dt.date | None = None
    replace: bool = False


class PantryUpdate(BaseModel):
    quantity: float | None = Field(None, ge=0)
    unit: str | None = None
    expires_on: dt.date | None = None


class MenuIn(BaseModel):
    day: dt.date
    meal_type: str
    recipe_id: int
    servings: int | None = Field(None, ge=1)


class MenuUpdate(BaseModel):
    recipe_id: int | None = None
    servings: int | None = Field(None, ge=1)


class AutoplanIn(BaseModel):
    start: dt.date
    days: int = Field(7, ge=1, le=31)
    meal_types: list[str] = Field(default_factory=lambda: ["almuerzo", "cena"])
    servings: int | None = Field(None, ge=1)
    overwrite: bool = False


class CookIn(BaseModel):
    servings: int | None = Field(None, ge=1)


class IngredientUpdate(BaseModel):
    category: str | None = None
    g_per_cup: float | None = Field(None, gt=0)  # cuánto pesa 1 taza (240 ml)
    g_per_unit: float | None = Field(None, gt=0)  # cuánto pesa 1 unidad


class SettingsIn(BaseModel):
    household_size: int = Field(ge=1, le=50)


def _validate_meals(meals: list[str]) -> list[str]:
    bad = [m for m in meals if m not in MEAL_TYPES]
    if bad:
        raise HTTPException(422, f"Tipo de comida no válido: {', '.join(bad)}")
    return meals


def _get_recipe(session: Session, recipe_id: int) -> Recipe:
    recipe = session.get(Recipe, recipe_id)
    if not recipe:
        raise HTTPException(404, "Receta no encontrada")
    return recipe


def _pantry_out(item: PantryItem, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    days_left = (item.expires_on - today).days if item.expires_on else None
    return {
        "id": item.id,
        "ingredient_id": item.ingredient_id,
        "name": item.ingredient.name,
        "category": item.ingredient.category,
        "g_per_cup": round(item.ingredient.g_per_ml * 240, 1) if item.ingredient.g_per_ml else None,
        "g_per_unit": item.ingredient.g_per_unit,
        "quantity": item.quantity,
        "unit": item.unit,
        "expires_on": item.expires_on.isoformat() if item.expires_on else None,
        "days_left": days_left,
        "expiring": days_left is not None and days_left <= services.EXPIRING_DAYS,
    }


def _menu_out(e: MenuEntry) -> dict:
    return {
        "id": e.id,
        "day": e.day.isoformat(),
        "meal_type": e.meal_type,
        "servings": e.servings,
        "cooked": e.cooked,
        "recipe": services.recipe_summary(e.recipe),
    }


# ---------------------------------------------------------------- catálogos

@app.get("/api/meta")
def meta(session: Session = SessionDep):
    return {
        "meal_types": MEAL_TYPES,
        "dish_types": DISH_TYPES,
        "categories": INGREDIENT_CATEGORIES,
        "units": list(UNITS),
        "household_size": services.household_size(session),
        "vision_model": vision.MODEL,
    }


@app.put("/api/settings")
def update_settings(data: SettingsIn, session: Session = SessionDep):
    session.merge(Setting(key="household_size", value=str(data.household_size)))
    session.commit()
    return {"household_size": data.household_size}


@app.get("/api/ingredients")
def list_ingredients(session: Session = SessionDep):
    return session.exec(select(Ingredient).order_by(Ingredient.name)).all()


@app.patch("/api/ingredients/{ingredient_id}")
def update_ingredient(ingredient_id: int, data: IngredientUpdate, session: Session = SessionDep):
    """Equivalencias de la casa: p. ej. 1 taza de arroz = 200 g, 1 zanahoria = 80 g."""
    ing = session.get(Ingredient, ingredient_id)
    if not ing:
        raise HTTPException(404, "Ingrediente no encontrado")
    fields = data.model_dump(exclude_unset=True)
    if "category" in fields and fields["category"]:
        ing.category = fields["category"]
    if "g_per_cup" in fields:
        ing.g_per_ml = fields["g_per_cup"] / 240 if fields["g_per_cup"] else None
    if "g_per_unit" in fields:
        ing.g_per_unit = fields["g_per_unit"]
    session.commit()
    session.refresh(ing)
    return ing


# ---------------------------------------------------------------- recetas

@app.get("/api/recipes")
def list_recipes(
    meal_type: str | None = None,
    dish_type: str | None = None,
    q: str | None = None,
    session: Session = SessionDep,
):
    pantry = services.load_pantry(session)
    size = services.household_size(session)
    out = []
    for r in session.exec(select(Recipe).order_by(Recipe.name)):
        if meal_type and meal_type not in r.meal_type_list:
            continue
        if dish_type and r.dish_type != dish_type:
            continue
        if q and q.lower() not in r.name.lower():
            continue
        avail = services.check_availability(r, size, pantry)
        out.append({
            **services.recipe_summary(r),
            "coverage": avail["coverage"],
            "can_cook": avail["can_cook"],
        })
    return out


@app.post("/api/recipes", status_code=201)
def create_recipe(data: RecipeIn, session: Session = SessionDep):
    recipe = Recipe(**data.model_dump(exclude={"ingredients", "meal_types"}),
                    meal_types=",".join(_validate_meals(data.meal_types)))
    session.add(recipe)
    session.flush()
    services.set_recipe_ingredients(session, recipe, data.ingredients)
    session.commit()
    session.refresh(recipe)
    return services.recipe_detail(recipe)


@app.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int, servings: int | None = None, session: Session = SessionDep):
    recipe = _get_recipe(session, recipe_id)
    return services.recipe_detail(recipe, servings, services.load_pantry(session))


@app.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, data: RecipeIn, session: Session = SessionDep):
    recipe = _get_recipe(session, recipe_id)
    for k, v in data.model_dump(exclude={"ingredients", "meal_types"}).items():
        setattr(recipe, k, v)
    recipe.meal_types = ",".join(_validate_meals(data.meal_types))
    services.set_recipe_ingredients(session, recipe, data.ingredients)
    session.commit()
    session.refresh(recipe)
    return services.recipe_detail(recipe)


@app.delete("/api/recipes/{recipe_id}", status_code=204)
def delete_recipe(recipe_id: int, session: Session = SessionDep):
    recipe = _get_recipe(session, recipe_id)
    for e in session.exec(select(MenuEntry).where(MenuEntry.recipe_id == recipe_id)):
        session.delete(e)
    session.delete(recipe)
    session.commit()


@app.post("/api/recipes/{recipe_id}/cook")
def cook_recipe(recipe_id: int, data: CookIn, session: Session = SessionDep):
    recipe = _get_recipe(session, recipe_id)
    servings = data.servings or services.household_size(session)
    changes = services.cook(session, recipe, servings)
    session.commit()
    return {"pantry_changes": changes}


# ---------------------------------------------------------------- despensa

@app.get("/api/pantry")
def list_pantry(session: Session = SessionDep):
    items = session.exec(select(PantryItem)).all()
    out = [_pantry_out(i) for i in items]
    out.sort(key=lambda i: (i["category"], i["name"]))
    return out


@app.post("/api/pantry", status_code=201)
def add_pantry(data: PantryIn, session: Session = SessionDep):
    item = services.add_to_pantry(session, **data.model_dump())
    session.commit()
    session.refresh(item)
    return _pantry_out(item)


@app.post("/api/pantry/bulk", status_code=201)
def add_pantry_bulk(items: list[PantryIn], session: Session = SessionDep):
    added = [services.add_to_pantry(session, **d.model_dump()) for d in items]
    session.commit()
    return [_pantry_out(i) for i in added]


@app.patch("/api/pantry/{item_id}")
def update_pantry(item_id: int, data: PantryUpdate, session: Session = SessionDep):
    item = session.get(PantryItem, item_id)
    if not item:
        raise HTTPException(404, "No está en la despensa")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    item.updated_at = utcnow()
    session.commit()
    session.refresh(item)
    return _pantry_out(item)


@app.delete("/api/pantry/{item_id}", status_code=204)
def delete_pantry(item_id: int, session: Session = SessionDep):
    item = session.get(PantryItem, item_id)
    if item:
        session.delete(item)
        session.commit()


@app.post("/api/pantry/scan")
async def scan_pantry(photo: UploadFile = File(...), session: Session = SessionDep):
    """Reconoce lo que hay en una foto. No guarda nada: la familia confirma primero."""
    known = [i.name for i in session.exec(select(Ingredient))]
    data = await photo.read()
    try:
        result = vision.detect_pantry(data, photo.content_type or "", known)
    except vision.VisionError as e:
        raise HTTPException(e.status, str(e)) from e
    keys = {services.ingredient_key(n) for n in known}
    return {
        "notes": result.notes,
        "items": [
            {**i.model_dump(), "known": services.ingredient_key(i.name) in keys}
            for i in result.items
        ],
    }


@app.post("/api/recipes/import")
async def import_recipe(
    text: str | None = Form(None),
    photo: UploadFile | None = File(None),
    session: Session = SessionDep,
):
    """Convierte una receta escrita (texto o foto) en un borrador para revisar y guardar."""
    known = [i.name for i in session.exec(select(Ingredient))]
    image = None
    if photo is not None and photo.filename:
        image = (await photo.read(), photo.content_type or "")
    try:
        draft = vision.parse_recipe(text, image, known)
    except vision.VisionError as e:
        raise HTTPException(e.status, str(e)) from e
    data = draft.model_dump()
    data["meal_types"] = [m for m in data["meal_types"] if m in MEAL_TYPES] or ["almuerzo"]
    if data["dish_type"] not in DISH_TYPES:
        data["dish_type"] = "plato principal"
    return data


# ---------------------------------------------------------------- qué cocino

@app.get("/api/suggestions")
def suggestions(
    meal_type: str | None = None,
    dish_type: str | None = None,
    servings: int | None = None,
    limit: int = 10,
    session: Session = SessionDep,
):
    return services.suggest(session, meal_type, servings, dish_type, limit=limit)


# ---------------------------------------------------------------- menú

@app.get("/api/menu")
def get_menu(start: dt.date, days: int = 7, session: Session = SessionDep):
    end = start + dt.timedelta(days=days - 1)
    entries = session.exec(
        select(MenuEntry).where(MenuEntry.day >= start, MenuEntry.day <= end)
        .order_by(MenuEntry.day)
    ).all()
    return [_menu_out(e) for e in entries]


@app.post("/api/menu", status_code=201)
def add_menu(data: MenuIn, session: Session = SessionDep):
    _validate_meals([data.meal_type])
    _get_recipe(session, data.recipe_id)
    entry = MenuEntry(
        day=data.day, meal_type=data.meal_type, recipe_id=data.recipe_id,
        servings=data.servings or services.household_size(session),
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return _menu_out(entry)


@app.patch("/api/menu/{entry_id}")
def update_menu(entry_id: int, data: MenuUpdate, session: Session = SessionDep):
    entry = session.get(MenuEntry, entry_id)
    if not entry:
        raise HTTPException(404, "No está en el menú")
    if data.recipe_id is not None:
        _get_recipe(session, data.recipe_id)
        entry.recipe_id = data.recipe_id
    if data.servings is not None:
        entry.servings = data.servings
    session.commit()
    session.refresh(entry)
    return _menu_out(entry)


@app.delete("/api/menu/{entry_id}", status_code=204)
def delete_menu(entry_id: int, session: Session = SessionDep):
    entry = session.get(MenuEntry, entry_id)
    if entry:
        session.delete(entry)
        session.commit()


@app.post("/api/menu/autoplan", status_code=201)
def menu_autoplan(data: AutoplanIn, session: Session = SessionDep):
    created = services.autoplan(
        session, data.start, data.days, _validate_meals(data.meal_types),
        data.servings, data.overwrite,
    )
    session.commit()
    for e in created:
        session.refresh(e)
    return [_menu_out(e) for e in created]


@app.post("/api/menu/{entry_id}/cook")
def cook_menu(entry_id: int, session: Session = SessionDep):
    entry = session.get(MenuEntry, entry_id)
    if not entry:
        raise HTTPException(404, "No está en el menú")
    if entry.cooked:
        raise HTTPException(409, "Ya se marcó como cocinado")
    changes = services.cook(session, entry.recipe, entry.servings, entry.day)
    entry.cooked = True
    session.commit()
    return {"pantry_changes": changes}


@app.get("/api/shopping-list")
def get_shopping_list(start: dt.date, days: int = 7, session: Session = SessionDep):
    return services.shopping_list(session, start, start + dt.timedelta(days=days - 1))


# ---------------------------------------------------------------- interfaz

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")

from __future__ import annotations

import datetime as dt
import io
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from typing import Literal

import segno
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from . import agenda, ai, clock, gcal, household, inventory, prize_icons, rewards, services, storage, vision, voice
from .auth import AuthMiddleware, check_pin, pin_enabled
from . import db
from .db import get_session, init_db
from .models import (
    DISH_TYPES,
    CHORE_EMOJIS,
    INGREDIENT_CATEGORIES,
    MEAL_TYPES,
    Chore,
    ChoreLog,
    Event,
    FamilyPhoto,
    Ingredient,
    Member,
    ShoppingExtra,
    MenuEntry,
    PantryItem,
    Prize,
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

app.add_middleware(AuthMiddleware)

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
    min_quantity: float | None = Field(None, ge=0)
    replace: bool = False


class PantryUpdate(BaseModel):
    quantity: float | None = Field(None, ge=0)
    unit: str | None = None
    expires_on: dt.date | None = None
    min_quantity: float | None = Field(None, ge=0)


class ReviewLine(BaseModel):
    id: int
    state: Literal["ok", "low", "out"]
    quantity: float | None = Field(None, ge=0)
    unit: str | None = Field(None, max_length=20)  # "porcion" para contar en porciones


class ReviewIn(BaseModel):
    items: list[ReviewLine] = Field(default_factory=list)


class MemberIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    emoji: str = Field("🙂", max_length=8)
    kid: bool | None = None  # None = no cambia


class PrizeIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    stars: int = Field(ge=1, le=500)  # en qué estrella del camino se gana
    icon: str = Field("", max_length=80)  # "fluent-emoji-flat:ice-cream"; vacío = se queda la imagen que tiene


class ChoreIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    emoji: str = Field("🧹", max_length=8)
    every_days: int = Field(7, ge=1, le=365)
    member_id: int | None = None
    rotate: bool = False
    schedule: Literal["every", "weekdays", "monthday"] = "every"
    weekdays: list[int] = Field(default_factory=list)  # 0 = lunes … 6 = domingo
    month_day: int | None = Field(None, ge=1, le=31)
    remind_at: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    stars: int | None = Field(None, ge=1, le=5)  # None = no cambia (nueva: 1)

    def to_fields(self) -> dict:
        data = self.model_dump()
        if data["stars"] is None:
            del data["stars"]
        days = sorted({d for d in self.weekdays if 0 <= d <= 6})
        if self.schedule == "weekdays" and not days:
            raise HTTPException(422, "Elijan al menos un día de la semana.")
        if self.schedule == "monthday" and not self.month_day:
            raise HTTPException(422, "Digan qué día del mes.")
        data["weekdays"] = ",".join(map(str, days))
        return data


class ChoreDone(BaseModel):
    member_id: int | None = None


class ReceiptLineIn(BaseModel):
    raw_text: str = ""
    name: str = Field(min_length=1)
    quantity: float = Field(ge=0)
    unit: str = "unidad"
    category: str | None = None
    price: float | None = None
    expires_on: dt.date | None = None


class ReceiptIn(BaseModel):
    store: str = ""
    day: dt.date | None = None
    total: float | None = None
    items: list[ReceiptLineIn]


class ExtraIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    quantity: float | None = Field(None, ge=0)
    unit: str | None = None


class VoiceIn(BaseModel):
    text: str = Field(max_length=500)
    context: dict = Field(default_factory=dict)


class PinIn(BaseModel):
    pin: str


# servings = adultos; kids = niños (comen menos, según «Un niño come…» de la casa)
class MenuIn(BaseModel):
    day: dt.date
    meal_type: str
    recipe_id: int
    servings: int | None = Field(None, ge=0)
    kids: int | None = Field(None, ge=0)


class MenuUpdate(BaseModel):
    recipe_id: int | None = None
    servings: int | None = Field(None, ge=0)
    kids: int | None = Field(None, ge=0)


class AutoplanIn(BaseModel):
    start: dt.date
    days: int = Field(7, ge=1, le=31)
    meal_types: list[str] = Field(default_factory=lambda: ["almuerzo", "cena"])
    servings: int | None = Field(None, ge=0)
    kids: int | None = Field(None, ge=0)
    overwrite: bool = False


class CookIn(BaseModel):
    servings: int | None = Field(None, ge=0)
    kids: int | None = Field(None, ge=0)


class IngredientUpdate(BaseModel):
    category: str | None = None
    staple: bool | None = None  # básico que siempre hay
    g_per_cup: float | None = Field(None, gt=0)  # cuánto pesa 1 taza (240 ml)
    g_per_unit: float | None = Field(None, gt=0)  # cuánto pesa 1 unidad


class SettingsIn(BaseModel):
    household_size: int | None = Field(None, ge=1, le=50)  # adultos
    household_kids: int | None = Field(None, ge=0, le=20)
    kid_portion: float | None = Field(None, ge=0.1, le=1)
    house_name: str | None = Field(None, max_length=60)
    wake_word: str | None = Field(None, max_length=40)
    inventory_mode: str | None = None
    ai_photo_model: str | None = Field(None, max_length=80)
    ai_text_model: str | None = Field(None, max_length=80)


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
    today = today or clock.today()
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
        "min_quantity": item.min_quantity,
        "low": item.min_quantity is not None and item.quantity < item.min_quantity,
        "days_left": days_left,
        "expiring": days_left is not None and days_left <= services.EXPIRING_DAYS,
    }


def _menu_out(e: MenuEntry) -> dict:
    return {
        "id": e.id,
        "day": e.day.isoformat(),
        "meal_type": e.meal_type,
        "servings": e.servings,
        "kids": e.kids or 0,
        "cooked": e.cooked,
        "recipe": services.recipe_summary(e.recipe),
    }


# ---------------------------------------------------------------- catálogos

def _household(session: Session) -> dict:
    return {
        "household_size": services.household_size(session),  # adultos
        "household_kids": services.household_kids(session),
        "kid_portion": services.kid_portion(session),
    }


def _servings(session: Session, adults: int | None, kids: int | None) -> tuple[int, int]:
    """Adultos y niños para una comida; sin datos, los de la casa."""
    if adults is None:
        return services.household_size(session), services.household_kids(session) if kids is None else kids
    if adults + (kids or 0) < 1:
        raise HTTPException(422, "Tiene que comer al menos una persona.")
    return adults, kids or 0


@app.get("/api/meta")
def meta(session: Session = SessionDep):
    return {
        "meal_types": MEAL_TYPES,
        "dish_types": DISH_TYPES,
        "categories": INGREDIENT_CATEGORIES,
        "units": list(UNITS),
        **_household(session),
        "house_name": _house_name(session),
        "wake_word": _wake_word(session),
        "inventory_mode": services.inventory_mode(session),
        "ai": _ai_status(session),
        "chore_emojis": CHORE_EMOJIS,
        "prizes": [{"icon": i, "name": n, "url": prize_icons.bundled_url(i)} for i, n in prize_icons.PRIZES],
        # Los grupos de la despensa como los piensa la casa (los mismos de «¿Qué hay?» en la tablet)
        "inventory_groups": [{"key": k, "label": label, "icon": ic, "categories": cats}
                             for k, label, ic, cats in inventory.GROUPS],
    }


@app.get("/api/auth")
def auth_status():
    return {"pin_required": pin_enabled()}


@app.post("/api/login")
def login(data: PinIn, request: Request):
    return check_pin(data.pin, request)


@app.put("/api/settings")
def update_settings(data: SettingsIn, session: Session = SessionDep):
    if data.household_size is not None:
        session.merge(Setting(key="household_size", value=str(data.household_size)))
    if data.household_kids is not None:
        session.merge(Setting(key="household_kids", value=str(data.household_kids)))
    if data.kid_portion is not None:
        session.merge(Setting(key="kid_portion", value=str(round(data.kid_portion, 3))))
    if data.house_name is not None:
        session.merge(Setting(key="house_name", value=data.house_name.strip()))
    if data.wake_word is not None:
        word = " ".join(data.wake_word.split())
        if len(word) < 3:
            raise HTTPException(422, "La palabra de activación es muy corta. Usen dos palabras, como «Oye casa».")
        session.merge(Setting(key="wake_word", value=word))
    for role in ai.ROLES:
        value = getattr(data, ai.ROLES[role]["setting"])
        if value is not None:
            value = value.strip().removeprefix("models/")
            if value and not ai.MODEL_NAME.match(value):
                raise HTTPException(422, "Ese nombre de modelo no es válido.")
            session.merge(Setting(key=ai.ROLES[role]["setting"], value=value))
    if data.inventory_mode is not None:
        if data.inventory_mode not in services.INVENTORY_MODES:
            raise HTTPException(422, "Modo de inventario desconocido.")
        session.merge(Setting(key="inventory_mode", value=data.inventory_mode))
    session.commit()
    return {
        **_household(session),
        "house_name": _house_name(session),
        "wake_word": _wake_word(session),
        "inventory_mode": services.inventory_mode(session),
        "ai": _ai_status(session),
    }


ai_model = ai.model_for


def _ai_status(session: Session) -> dict:
    return {
        role: {"provider": r["provider"], "key_env": r["key_env"], "configured": ai.configured(role),
               "model": ai_model(session, role), "default": r["default"]}
        for role, r in ai.ROLES.items()
    }


@app.get("/api/ai/models")
def ai_models(role: Literal["photo", "text"]):
    """Modelos que su clave puede usar (para la lista de Ajustes)."""
    try:
        return {"models": ai.list_models(role)}
    except ai.AIError as e:
        raise HTTPException(e.status, str(e)) from e


class AITestIn(BaseModel):
    role: Literal["photo", "text"]


@app.post("/api/ai/test")
def ai_test(data: AITestIn, session: Session = SessionDep):
    model = ai_model(session, data.role)
    started = time.time()
    try:
        ai.test_model(data.role, model)
    except ai.AIError as e:
        raise HTTPException(e.status, str(e)) from e
    return {"ok": True, "model": model, "seconds": round(time.time() - started, 1)}


def _wake_word(session: Session) -> str:
    s = session.get(Setting, "wake_word")
    return s.value if s and s.value else "Oye casa"


def _house_name(session: Session) -> str:
    s = session.get(Setting, "house_name")
    return s.value if s and s.value else "Nuestra casa"


def _ingredient_out(ing: Ingredient) -> dict:
    return {**ing.model_dump(), "is_staple": ing.is_staple}


@app.get("/api/ingredients")
def list_ingredients(session: Session = SessionDep):
    return [_ingredient_out(i) for i in session.exec(select(Ingredient).order_by(Ingredient.name))]


@app.patch("/api/ingredients/{ingredient_id}")
def update_ingredient(ingredient_id: int, data: IngredientUpdate, session: Session = SessionDep):
    """Equivalencias de la casa (1 taza de arroz = 200 g) y si es un básico que siempre hay."""
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
    if "staple" in fields:
        ing.staple = fields["staple"]
    session.commit()
    session.refresh(ing)
    return _ingredient_out(ing)


class StapleIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    staple: bool = True


@app.post("/api/staples")
def set_staple(data: StapleIn, session: Session = SessionDep):
    """Marca (o desmarca) por nombre un básico que siempre hay; lo crea si no existe."""
    ing = services.get_or_create_ingredient(session, data.name.strip())
    ing.staple = data.staple
    session.commit()
    session.refresh(ing)
    return _ingredient_out(ing)


# ---------------------------------------------------------------- recetas

@app.get("/api/recipes")
def list_recipes(
    meal_type: str | None = None,
    dish_type: str | None = None,
    q: str | None = None,
    session: Session = SessionDep,
):
    pantry = services.load_pantry(session)
    size = services.portions(session)
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
def get_recipe(recipe_id: int, servings: int | None = None, kids: int | None = None,
               session: Session = SessionDep):
    """servings = adultos y kids = niños; sin servings, la receta tal como está escrita."""
    recipe = _get_recipe(session, recipe_id)
    eaten = None
    if servings is not None:
        servings, kids = _servings(session, servings, kids)
        eaten = services.portions(session, servings, kids)
    data = services.recipe_detail(recipe, eaten, services.load_pantry(session))
    data["adults"] = servings if servings is not None else recipe.servings
    data["kids"] = kids or 0
    return data


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
    adults, kids = _servings(session, data.servings, data.kids)
    changes = services.cook(session, recipe, adults, kids=kids)
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
    added = []
    for d in items:
        item = services.add_to_pantry(session, **d.model_dump())
        household._clear_extras_for(session, item.ingredient.name)
        added.append(item)
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


@app.get("/api/inventory")
def get_inventory(session: Session = SessionDep):
    """Lo que hay en la casa por grupos (proteínas, lácteos…), para revisarlo el fin de semana."""
    return inventory.overview(session, _pantry_out)


@app.post("/api/inventory/{group}/review")
def review_inventory(group: str, data: ReviewIn, session: Session = SessionDep):
    if group not in inventory.GROUP_KEYS:
        raise HTTPException(404, "Ese grupo no existe")
    result = inventory.save_group(session, group, data.items)
    session.commit()
    return result


# Qué se suele guardar en cada lugar, para preguntar por lo que no salió en la foto.
PLACE_CATEGORIES = {
    "nevera": {"verduras", "frutas", "carnes", "pescados", "lácteos y huevos", "congelados"},
    "alacena": {"granos y harinas", "legumbres", "enlatados", "aceites y salsas", "panadería", "bebidas"},
}


def _spot(item, n_photos: int) -> dict:
    """Punto donde marcar el artículo (0–1 de ancho y alto) o None si no se pudo señalar."""
    if 0 <= item.photo < n_photos and 0 <= item.x <= 1000 and 0 <= item.y <= 1000:
        return {"photo": item.photo, "x": round(item.x / 1000, 4), "y": round(item.y / 1000, 4)}
    return {"photo": None, "x": None, "y": None}


@app.post("/api/pantry/scan")
async def scan_pantry(
    photos: list[UploadFile] | None = File(None),
    photo: UploadFile | None = File(None),
    place: str = Form("nevera"),
    session: Session = SessionDep,
):
    """Reconoce lo que hay en una o varias fotos. No guarda nada: la familia confirma primero."""
    known = [i.name for i in session.exec(select(Ingredient))]
    uploads = [*(photos or []), *([photo] if photo else [])]
    images = [(await p.read(), p.content_type or "") for p in uploads][:6]
    try:
        result = vision.detect_pantry(images, known, place, model=ai_model(session, "photo"))
    except vision.VisionError as e:
        raise HTTPException(e.status, str(e)) from e
    keys = {services.ingredient_key(n) for n in known}
    seen = {services.ingredient_key(i.name) for i in result.items}
    categories = set(INGREDIENT_CATEGORIES)
    # Lo que según el inventario debería estar en ese lugar y no apareció: ¿se acabó?
    not_seen = [
        {"name": p.ingredient.name, "quantity": p.quantity, "unit": p.unit}
        for p in session.exec(select(PantryItem).where(PantryItem.quantity > 0))
        if p.ingredient.category in PLACE_CATEGORIES.get(place, set())
        and p.ingredient.key not in seen and not p.ingredient.is_staple
    ]
    return {
        "notes": result.notes,
        "items": [
            {
                **i.model_dump(),
                "category": i.category if i.category in categories else "otros",
                "known": services.ingredient_key(i.name) in keys,
                **_spot(i, len(images)),
            }
            for i in result.items
        ],
        "not_seen": sorted(not_seen, key=lambda x: x["name"]),
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
        draft = vision.parse_recipe(
            text, image, known, photo_model=ai_model(session, "photo"), text_model=ai_model(session, "text")
        )
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
    kids: int | None = None,
    day: dt.date | None = None,
    session: Session = SessionDep,
):
    """day = el día que se está planeando (para decir hace cuánto estuvo cada receta en el menú)."""
    adults, kids = _servings(session, servings, kids)
    return services.suggest(session, meal_type, services.portions(session, adults, kids), dish_type,
                            today=day, limit=limit)


# ---------------------------------------------------------------- menú

@app.get("/api/menu")
def get_menu(start: dt.date, days: int = 7, session: Session = SessionDep):
    end = start + dt.timedelta(days=days - 1)
    entries = session.exec(
        select(MenuEntry).where(MenuEntry.day >= start, MenuEntry.day <= end)
        .order_by(MenuEntry.day)
    ).all()
    # Cada plato dice si hoy hay todo lo que pide (para los adultos y niños de esa comida).
    pantry = services.load_pantry(session)
    out = []
    for e in entries:
        avail = services.check_availability(e.recipe, services.entry_portions(session, e), pantry)
        out.append({
            **_menu_out(e),
            "can_cook": avail["can_cook"],
            "missing": [i["name"] for i in avail["items"] if i["status"] in ("falta", "poco") and not i["optional"]],
        })
    return out


@app.post("/api/menu", status_code=201)
def add_menu(data: MenuIn, session: Session = SessionDep):
    _validate_meals([data.meal_type])
    _get_recipe(session, data.recipe_id)
    adults, kids = _servings(session, data.servings, data.kids)
    entry = MenuEntry(day=data.day, meal_type=data.meal_type, recipe_id=data.recipe_id,
                      servings=adults, kids=kids)
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
    if data.kids is not None:
        entry.kids = data.kids
    if entry.servings + (entry.kids or 0) < 1:
        raise HTTPException(422, "Tiene que comer al menos una persona.")
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
        data.servings, data.overwrite, kids=data.kids,
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
    changes = services.cook(session, entry.recipe, entry.servings, entry.day, kids=entry.kids or 0)
    entry.cooked = True
    session.commit()
    return {"pantry_changes": changes}


@app.get("/api/shopping-list")
def get_shopping_list(start: dt.date, days: int = 7, session: Session = SessionDep):
    """Menú de la semana + lo que se está acabando + lo anotado a mano."""
    return household.full_shopping_list(session, start, start + dt.timedelta(days=days - 1))


@app.post("/api/shopping/extra", status_code=201)
def add_extra(data: ExtraIn, session: Session = SessionDep):
    key = services.ingredient_key(data.name)
    for e in session.exec(select(ShoppingExtra)):
        if services.ingredient_key(e.name) == key:
            return e
    name = data.name.strip()
    extra = ShoppingExtra(name=name[0].upper() + name[1:], quantity=data.quantity, unit=data.unit)
    session.add(extra)
    session.commit()
    session.refresh(extra)
    return extra


@app.delete("/api/shopping/extra/{extra_id}", status_code=204)
def delete_extra(extra_id: int, session: Session = SessionDep):
    extra = session.get(ShoppingExtra, extra_id)
    if extra:
        session.delete(extra)
        session.commit()


@app.post("/api/shopping/ran-out", status_code=201)
def ran_out(data: ExtraIn, session: Session = SessionDep):
    """"Se acabó X": lo deja en cero en el inventario y lo anota en la lista."""
    key = services.ingredient_key(data.name)
    ing = session.exec(select(Ingredient).where(Ingredient.key == key)).first()
    if ing:
        item = session.exec(select(PantryItem).where(PantryItem.ingredient_id == ing.id)).first()
        if item:
            item.quantity = 0
            item.updated_at = utcnow()
    session.commit()
    return add_extra(ExtraIn(name=ing.name if ing else data.name), session)


# ---------------------------------------------------------------- foto con el celular
# La tablet muestra un código QR; el celular lo abre, toma la foto y guarda. La tablet
# pregunta cada par de segundos si ya terminó. Vive en memoria: dura lo que dura la foto.

SCAN_TTL = 15 * 60
SCAN_SESSIONS: dict[str, dict] = {}


class ScanSessionIn(BaseModel):
    kind: Literal["receipt", "nevera", "alacena"]


class ScanDoneIn(BaseModel):
    summary: str = Field("", max_length=300)


def _scan_session(sid: str) -> dict:
    now = time.time()
    for k in [k for k, v in SCAN_SESSIONS.items() if now - v["created"] > SCAN_TTL]:
        del SCAN_SESSIONS[k]
    if sid not in SCAN_SESSIONS:
        raise HTTPException(404, "Este código ya venció. Pidan uno nuevo en la tablet.")
    return SCAN_SESSIONS[sid]


@app.post("/api/scan-sessions", status_code=201)
def new_scan_session(data: ScanSessionIn, request: Request):
    sid = secrets.token_urlsafe(9)
    url = f"{str(request.base_url).rstrip('/')}/?scan={data.kind}&s={sid}"
    SCAN_SESSIONS[sid] = {"kind": data.kind, "status": "waiting", "summary": "", "url": url, "created": time.time()}
    return {
        "id": sid,
        "url": url,
        # Con "localhost" el celular no llega: hay que abrir la app en la tablet con la IP del servidor.
        "local_only": request.url.hostname in ("localhost", "127.0.0.1", "::1"),
    }


@app.get("/api/scan-sessions/{sid}")
def get_scan_session(sid: str):
    s = _scan_session(sid)
    return {"kind": s["kind"], "status": s["status"], "summary": s["summary"]}


@app.get("/api/scan-sessions/{sid}/qr.svg", include_in_schema=False)
def scan_session_qr(sid: str):
    buf = io.BytesIO()
    segno.make(_scan_session(sid)["url"], error="m").save(buf, kind="svg", scale=8, border=2, dark="#123d2a")
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.post("/api/scan-sessions/{sid}/opened")
def scan_session_opened(sid: str):
    s = _scan_session(sid)
    if s["status"] == "waiting":
        s["status"] = "opened"
    return {"status": s["status"]}


@app.post("/api/scan-sessions/{sid}/done")
def scan_session_done(sid: str, data: ScanDoneIn):
    s = _scan_session(sid)
    s["status"], s["summary"] = "done", data.summary
    return {"status": "done"}


# ---------------------------------------------------------------- facturas

@app.post("/api/receipts/scan")
async def scan_receipt(photos: list[UploadFile] = File(...), session: Session = SessionDep):
    """Lee la factura con IA. No guarda nada: la familia revisa y confirma."""
    known = [i.name for i in session.exec(select(Ingredient))]
    images = [(await p.read(), p.content_type or "") for p in photos]
    try:
        receipt = vision.scan_receipt(images, known, model=ai_model(session, "photo"))
    except vision.VisionError as e:
        raise HTTPException(e.status, str(e)) from e
    keys = {services.ingredient_key(n) for n in known}
    day = None
    if receipt.date:
        try:
            day = dt.date.fromisoformat(receipt.date).isoformat()
        except ValueError:
            day = None
    categories = set(INGREDIENT_CATEGORIES)
    return {
        "store": receipt.store,
        "day": day,
        "total": receipt.total,
        "notes": receipt.notes,
        "items": [
            {
                **line.model_dump(),
                "category": line.category if line.category in categories else "otros",
                "known": services.ingredient_key(line.name) in keys,
                # por defecto se guarda comida y cosas de la casa; no bolsas ni domicilios
                "keep": line.kind != "otro",
            }
            for line in receipt.items
        ],
    }


@app.post("/api/receipts", status_code=201)
def save_receipt(data: ReceiptIn, session: Session = SessionDep):
    purchase, added = household.save_purchase(session, data.store, data.day, data.total, data.items)
    session.commit()
    return {"purchase_id": purchase.id, "added": len(added)}


@app.get("/api/purchases")
def purchases(session: Session = SessionDep):
    return household.spending(session)


# ---------------------------------------------------------------- fotos de la familia

PHOTO_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_PHOTO_BYTES = 8 * 1024 * 1024


def _photo_out(p: FamilyPhoto) -> dict:
    return {"id": p.id, "url": f"/api/photos/{p.id}/file", "caption": p.caption}


@app.get("/api/photos")
def list_photos(session: Session = SessionDep):
    return [_photo_out(p) for p in session.exec(select(FamilyPhoto).order_by(FamilyPhoto.id))]


@app.post("/api/photos", status_code=201)
async def add_photo(
    photo: UploadFile = File(...), caption: str = Form(""), session: Session = SessionDep
):
    ext = PHOTO_TYPES.get(photo.content_type or "")
    if not ext:
        raise HTTPException(400, "Esa foto no se puede usar. Prueben con una JPG o PNG.")
    data = await photo.read()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(400, "La foto es muy pesada (más de 8 MB).")
    name = f"{uuid.uuid4().hex}{ext}"
    try:
        storage.photos().save(name, data, photo.content_type or "image/jpeg")
    except storage.StorageError as e:
        raise HTTPException(502, str(e)) from e
    item = FamilyPhoto(filename=name, caption=caption.strip()[:80])
    session.add(item)
    session.commit()
    session.refresh(item)
    return _photo_out(item)


@app.get("/api/photos/{photo_id}/file", include_in_schema=False)
def photo_file(photo_id: int, session: Session = SessionDep):
    item = session.get(FamilyPhoto, photo_id)
    try:
        data = storage.photos().read(item.filename) if item else None
    except storage.StorageError as e:
        raise HTTPException(502, str(e)) from e
    if data is None:
        raise HTTPException(404, "Foto no encontrada")
    ext = item.filename.rsplit(".", 1)[-1].lower()
    media = {"png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
    return Response(data, media_type=media, headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.delete("/api/photos/{photo_id}", status_code=204)
def delete_photo(photo_id: int, session: Session = SessionDep):
    item = session.get(FamilyPhoto, photo_id)
    if not item:
        return
    try:
        storage.photos().delete(item.filename)
    except storage.StorageError as e:
        raise HTTPException(502, str(e)) from e
    session.delete(item)
    session.commit()


# ---------------------------------------------------------------- voz

@app.post("/api/voice")
def voice_command(data: VoiceIn, session: Session = SessionDep):
    """Interpreta una frase dicha en la cocina y ejecuta lo que corresponde."""
    return voice.interpret(session, data.text, data.context).as_dict()


# ---------------------------------------------------------------- hoy y tareas

@app.get("/api/today")
def today(session: Session = SessionDep):
    data = household.today_summary(session)
    # En el inicio solo lo que viene: lo que ya pasó se ve (y se marca) en la Agenda
    today_iso = clock.today().isoformat()
    data["agenda"] = [e for e in agenda.upcoming(session, 7) if e["date"] >= today_iso][:8]
    data["inventory"] = inventory.last_review(session)
    return data


@app.get("/api/members")
def list_members(session: Session = SessionDep):
    return list(household.members_by_id(session).values())


@app.post("/api/members", status_code=201)
def add_member(data: MemberIn, session: Session = SessionDep):
    member = Member(**data.model_dump(exclude_none=True))
    session.add(member)
    session.commit()
    session.refresh(member)
    return member


@app.put("/api/members/{member_id}")
def update_member(member_id: int, data: MemberIn, session: Session = SessionDep):
    member = session.get(Member, member_id)
    if not member:
        raise HTTPException(404, "Persona no encontrada")
    member.name, member.emoji = data.name, data.emoji
    if data.kid is not None:
        member.kid = data.kid
    session.commit()
    session.refresh(member)
    return member


@app.delete("/api/members/{member_id}", status_code=204)
def delete_member(member_id: int, session: Session = SessionDep):
    member = session.get(Member, member_id)
    if not member:
        return
    for c in session.exec(select(Chore)):
        if c.member_id == member_id:
            c.member_id = None
        if c.last_done_by == member_id:
            c.last_done_by = None
    for e in session.exec(select(Event).where(Event.member_id == member_id)):
        e.member_id = None  # la cita queda, sin persona
    for prize in rewards.prizes_of(session, member):
        _drop_prize_photo(prize)
    rewards.forget_member(session, member_id)
    session.delete(member)
    session.commit()


def _get_chore(session: Session, chore_id: int) -> Chore:
    chore = session.get(Chore, chore_id)
    if not chore:
        raise HTTPException(404, "Tarea no encontrada")
    return chore


def _check_member(session: Session, member_id: int | None) -> None:
    if member_id is not None and not session.get(Member, member_id):
        raise HTTPException(422, "Esa persona no existe")


@app.get("/api/chores")
def list_chores(session: Session = SessionDep):
    return household.list_chores(session)


@app.get("/api/chores/stats")
def chores_stats(days: int = 30, session: Session = SessionDep):
    return household.chore_stats(session, days)


@app.post("/api/chores", status_code=201)
def add_chore(data: ChoreIn, session: Session = SessionDep):
    _check_member(session, data.member_id)
    chore = Chore(**data.to_fields())
    session.add(chore)
    session.commit()
    session.refresh(chore)
    return chore


@app.put("/api/chores/{chore_id}")
def update_chore(chore_id: int, data: ChoreIn, session: Session = SessionDep):
    chore = _get_chore(session, chore_id)
    _check_member(session, data.member_id)
    for k, v in data.to_fields().items():
        setattr(chore, k, v)
    session.commit()
    session.refresh(chore)
    return chore


# ---------------------------------------------------------------- logros de los niños

def _get_kid(session: Session, member_id: int) -> Member:
    member = session.get(Member, member_id)
    if not member:
        raise HTTPException(404, "Persona no encontrada")
    return member


@app.get("/api/kids")
def kids_achievements(session: Session = SessionDep):
    """Estrellas, meta, racha, insignias y tareas de hoy de cada niño de la casa."""
    return rewards.all_summaries(session)


@app.get("/api/kids/{member_id}")
def kid_achievements(member_id: int, session: Session = SessionDep):
    return rewards.summary(session, _get_kid(session, member_id))


def _get_prize(session: Session, member: Member, prize_id: int) -> Prize:
    prize = session.get(Prize, prize_id)
    if not prize or prize.member_id != member.id:
        raise HTTPException(404, "Ese premio no está")
    return prize


def _check_prize_stars(session: Session, member: Member, stars: int, prize_id: int | None = None) -> None:
    for p in rewards.prizes_of(session, member):
        if p.stars == stars and p.id != prize_id:
            raise HTTPException(422, f"Ya hay un premio en la estrella {stars}: «{p.name}». Elijan otro número.")


@app.post("/api/kids/{member_id}/prizes", status_code=201)
def add_prize(member_id: int, data: PrizeIn, session: Session = SessionDep):
    """Un premio más en el camino: «a las 15 estrellas, ir al parque»."""
    member = _get_kid(session, member_id)
    _check_prize_stars(session, member, data.stars)
    prize = Prize(member_id=member.id, name=data.name.strip(), stars=data.stars)
    session.add(prize)
    session.flush()
    if data.icon:
        _set_prize_icon(prize, data.icon)
    session.commit()
    return rewards.summary(session, member)


@app.put("/api/kids/{member_id}/prizes/{prize_id}")
def update_prize(member_id: int, prize_id: int, data: PrizeIn, session: Session = SessionDep):
    member = _get_kid(session, member_id)
    prize = _get_prize(session, member, prize_id)
    _check_prize_stars(session, member, data.stars, prize.id)
    prize.name, prize.stars = data.name.strip(), data.stars
    if data.icon:  # sin ícono se queda la imagen que tiene (por ejemplo su foto)
        _set_prize_icon(prize, data.icon)
    session.commit()
    return rewards.summary(session, member)


@app.delete("/api/kids/{member_id}/prizes/{prize_id}")
def delete_prize(member_id: int, prize_id: int, session: Session = SessionDep):
    member = _get_kid(session, member_id)
    prize = _get_prize(session, member, prize_id)
    _drop_prize_photo(prize)
    session.delete(prize)
    session.commit()
    return rewards.summary(session, member)


def _set_prize_icon(prize: Prize, icon_id: str) -> None:
    """Un ícono a color reemplaza la foto. Si no viene con la app, se descarga y se guarda en la casa."""
    if icon_id in rewards.LEGACY_ICONS:
        icon_id = f"fluent-emoji-flat:{rewards.LEGACY_ICONS[icon_id]}"
    if not prize_icons.ICON_ID.match(icon_id):
        raise HTTPException(422, "Ese dibujo no existe.")
    if icon_id == prize.icon and (prize.photo.endswith(".svg") or prize_icons.bundled_path(icon_id)):
        return  # ya es ese
    if prize_icons.bundled_path(icon_id):
        _drop_prize_photo(prize)
    else:
        try:
            svg = prize_icons.download(icon_id)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        except OSError as e:
            raise HTTPException(502, "No se pudo bajar el dibujo. Revisen el internet o elijan uno de los que trae la app.") from e
        name = f"premio-{uuid.uuid4().hex}.svg"
        try:
            storage.photos().save(name, svg, "image/svg+xml")
        except storage.StorageError as e:
            raise HTTPException(502, str(e)) from e
        _drop_prize_photo(prize)
        prize.photo = name
    prize.icon = icon_id


@app.get("/api/prize-icons")
def search_prize_icons(q: str = ""):
    """Buscar dibujos a color para un premio (en español o inglés). Necesita internet."""
    q = q.strip()[:60]
    if not q:
        return {"query": "", "icons": []}
    try:
        found = prize_icons.search(q)
    except (OSError, ValueError) as e:
        raise HTTPException(502, "Sin internet no se puede buscar. Elijan uno de los dibujos de la app.") from e
    return {"query": prize_icons.translate(q),
            "icons": [{"icon": i, "url": prize_icons.bundled_url(i) or prize_icons.preview_url(i)} for i in found]}


def _drop_prize_photo(prize: Prize) -> None:
    if prize.photo:
        try:
            storage.photos().delete(prize.photo)
        except storage.StorageError:
            pass  # si no se pudo borrar el archivo, igual deja de mostrarse
        prize.photo = ""


@app.post("/api/kids/{member_id}/prizes/{prize_id}/photo")
async def set_prize_photo(member_id: int, prize_id: int, photo: UploadFile = File(...), session: Session = SessionDep):
    """Foto del premio de verdad (el helado, el parque): la ven los niños que aún no leen."""
    member = _get_kid(session, member_id)
    prize = _get_prize(session, member, prize_id)
    ext = PHOTO_TYPES.get(photo.content_type or "")
    if not ext:
        raise HTTPException(400, "Esa foto no se puede usar. Prueben con una JPG o PNG.")
    data = await photo.read()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(400, "La foto es muy pesada (más de 8 MB).")
    name = f"premio-{uuid.uuid4().hex}{ext}"
    try:
        storage.photos().save(name, data, photo.content_type or "image/jpeg")
    except storage.StorageError as e:
        raise HTTPException(502, str(e)) from e
    _drop_prize_photo(prize)
    prize.photo, prize.icon = name, ""
    session.commit()
    return rewards.summary(session, member)


@app.get("/api/kids/{member_id}/prizes/{prize_id}/photo", include_in_schema=False)
def prize_photo(member_id: int, prize_id: int, session: Session = SessionDep):
    prize = session.get(Prize, prize_id)
    try:
        data = storage.photos().read(prize.photo) if prize and prize.member_id == member_id and prize.photo else None
    except storage.StorageError as e:
        raise HTTPException(502, str(e)) from e
    if data is None:
        raise HTTPException(404, "Foto no encontrada")
    ext = prize.photo.rsplit(".", 1)[-1].lower()
    media = {"png": "image/png", "webp": "image/webp", "svg": "image/svg+xml"}.get(ext, "image/jpeg")
    # Un SVG abierto directo no puede ejecutar nada (igual se revisa al bajarlo)
    return Response(data, media_type=media, headers={
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    })


@app.post("/api/kids/{member_id}/claim")
def claim_reward(member_id: int, session: Session = SessionDep):
    """Entregar el próximo premio al que ya llegó. No gasta estrellas: el camino sigue."""
    member = _get_kid(session, member_id)
    data = rewards.summary(session, member)
    if not data["goal"]:
        raise HTTPException(422, "Primero pongan un premio en el camino.")
    if not data["goal"]["ready"]:
        raise HTTPException(422, f"Todavía faltan {data['goal']['stars'] - data['stars']} estrellas.")
    rewards.claim(session, member)
    session.commit()
    return rewards.summary(session, member)


@app.post("/api/kids/{member_id}/claim/undo")
def undo_claim(member_id: int, session: Session = SessionDep):
    member = _get_kid(session, member_id)
    if rewards.undo_claim(session, member):
        session.commit()
    return rewards.summary(session, member)


@app.get("/api/reminders")
def chore_reminders(session: Session = SessionDep):
    """Lo que la tablet debe recordar en voz alta hoy, con la hora de la casa."""
    now = clock.now()
    items = household.reminders(session) + agenda.alerts(session, now.replace(tzinfo=None))
    if gcal.enabled(session):
        gcal.sync_soon(session.get_bind())  # la tablet pregunta cada minuto: de paso se trae lo de Google
    return {"now": now.strftime("%H:%M"), "today": now.date().isoformat(), "items": items}


# ---------------------------------------------------------------- agenda familiar

class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    category: Literal["salud", "colegio", "cumpleaños", "pagos", "familia", "otro"] = "familia"
    member_id: int | None = None
    day: dt.date
    time: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_day: dt.date | None = None
    end_time: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    notes: str = Field("", max_length=300)
    repeat: Literal["none", "weekly", "monthly", "yearly"] = "none"
    remind: list[int] = Field(default_factory=lambda: [60])

    def to_fields(self) -> dict:
        data = self.model_dump()
        data["title"] = self.title.strip()
        data["remind"] = ",".join(str(m) for m in sorted({m for m in self.remind if 0 <= m <= 10080}))
        if self.end_day and self.end_day <= self.day:
            data["end_day"] = None
        if not self.time or (not data["end_day"] and self.end_time and self.end_time <= self.time):
            data["end_time"] = None
        return data


def _get_event(session: Session, event_id: int) -> Event:
    event = session.get(Event, event_id)
    if not event:
        raise HTTPException(404, "No está en la agenda")
    return event


@app.get("/api/events")
def list_events(days: int = 60, start: dt.date | None = None, end: dt.date | None = None,
                session: Session = SessionDep):
    """Lo que viene (para la lista), o todo lo que cae entre start y end (para el calendario)."""
    if gcal.enabled(session):
        gcal.sync_soon(session.get_bind())
    if start and end:
        if end < start or (end - start).days > 62:
            raise HTTPException(422, "Pidan de a un mes como mucho.")
        return agenda.between(session, start, end)
    return agenda.upcoming(session, min(max(days, 1), 400))


def _changed(session: Session) -> None:
    """Algo cambió en la agenda: si hay calendario de Google, se sube ya."""
    if gcal.enabled(session):
        gcal.sync_soon(session.get_bind(), force=True)


@app.post("/api/events", status_code=201)
def add_event(data: EventIn, session: Session = SessionDep):
    _check_member(session, data.member_id)
    event = Event(**data.to_fields())
    session.add(event)
    session.commit()
    session.refresh(event)
    _changed(session)
    return agenda.event_out(event, event.day, {m.id: m for m in session.exec(select(Member))}, clock.today())


@app.put("/api/events/{event_id}")
def update_event(event_id: int, data: EventIn, session: Session = SessionDep):
    event = _get_event(session, event_id)
    _check_member(session, data.member_id)
    for k, v in data.to_fields().items():
        setattr(event, k, v)
    gcal.touched(event)
    session.commit()
    _changed(session)
    return {"ok": True}


@app.post("/api/events/{event_id}/done")
def event_done(event_id: int, session: Session = SessionDep):
    """Listo / ya pasó: deja de aparecer y de avisar (solo lo que no se repite)."""
    event = _get_event(session, event_id)
    event.done_on = clock.today()
    session.commit()
    return {"ok": True}


@app.post("/api/events/{event_id}/undone")
def event_undone(event_id: int, session: Session = SessionDep):
    event = _get_event(session, event_id)
    event.done_on = None
    session.commit()
    return {"ok": True}


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, session: Session = SessionDep):
    event = session.get(Event, event_id)
    if event:
        gcal.forget(session, event)
        session.delete(event)
        session.commit()
        _changed(session)


# ---------------------------------------------------------------- calendario de Google

class GCalIn(BaseModel):
    calendar_id: str = Field(min_length=3, max_length=200)


def _gcal_error(e: gcal.GCalError) -> HTTPException:
    return HTTPException(e.status if e.status < 500 else 502, str(e))


@app.get("/api/gcal")
def gcal_status(session: Session = SessionDep):
    return gcal.status(session)


@app.put("/api/gcal")
def gcal_connect(data: GCalIn, session: Session = SessionDep):
    try:
        return gcal.connect(session, data.calendar_id)
    except gcal.GCalError as e:
        raise _gcal_error(e) from e


@app.post("/api/gcal/sync")
def gcal_sync(session: Session = SessionDep):
    try:
        return {**gcal.sync(session), **gcal.status(session)}
    except gcal.GCalError as e:
        raise _gcal_error(e) from e


@app.delete("/api/gcal")
def gcal_disconnect(session: Session = SessionDep):
    gcal.disconnect(session)
    return gcal.status(session)


@app.delete("/api/chores/{chore_id}", status_code=204)
def delete_chore(chore_id: int, session: Session = SessionDep):
    chore = session.get(Chore, chore_id)
    if chore:
        for log in session.exec(select(ChoreLog).where(ChoreLog.chore_id == chore_id)):
            session.delete(log)
        session.delete(chore)
        session.commit()


@app.post("/api/chores/{chore_id}/done")
def chore_done(chore_id: int, data: ChoreDone, session: Session = SessionDep):
    chore = _get_chore(session, chore_id)
    _check_member(session, data.member_id)
    household.complete_chore(session, chore, data.member_id)
    session.commit()
    return household.list_chores(session)


@app.post("/api/chores/{chore_id}/undo")
def chore_undo(chore_id: int, session: Session = SessionDep):
    """Deshacer un toque por error: borra el último registro y vuelve al anterior."""
    chore = _get_chore(session, chore_id)
    logs = session.exec(
        select(ChoreLog).where(ChoreLog.chore_id == chore_id).order_by(ChoreLog.id.desc())
    ).all()
    if logs:
        session.delete(logs[0])
        prev = logs[1] if len(logs) > 1 else None
        chore.last_done = prev.day if prev else None
        chore.last_done_by = prev.member_id if prev else None
        session.commit()
    return household.list_chores(session)


# ---------------------------------------------------------------- interfaz

# La tablet queda prendida días enteros y nadie la recarga a mano. Si el navegador guarda una copia
# vieja del CSS o del JS, después de actualizar la app se mezclan versiones y una pantalla puede salir
# sin estilos. Por eso el HTML, el CSS y el JS se revalidan siempre (no-cache + ETag: si no cambiaron,
# el servidor responde 304 sin volver a enviarlos); las letras y las imágenes sí se guardan tiempo largo.
REVALIDATE = "no-cache"
CACHE_BY_EXT = {
    ".html": REVALIDATE, ".css": REVALIDATE, ".js": REVALIDATE, ".webmanifest": REVALIDATE,
    ".woff2": "public, max-age=31536000, immutable",
    ".svg": "public, max-age=86400", ".png": "public, max-age=86400", ".jpg": "public, max-age=86400",
}


class CasaStaticFiles(StaticFiles):
    def file_response(self, full_path, *args, **kwargs):
        response = super().file_response(full_path, *args, **kwargs)
        cache = CACHE_BY_EXT.get(Path(full_path).suffix.lower())
        if cache:
            response.headers["Cache-Control"] = cache
        return response


app.mount("/static", CasaStaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": REVALIDATE})


@app.get("/admin", include_in_schema=False)
def admin():
    return FileResponse(STATIC_DIR / "admin.html", headers={"Cache-Control": REVALIDATE})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": REVALIDATE})

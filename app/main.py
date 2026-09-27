from __future__ import annotations

import datetime as dt
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from . import household, services, vision
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
    FamilyPhoto,
    Ingredient,
    Member,
    ShoppingExtra,
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


class MemberIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    emoji: str = Field("🙂", max_length=8)


class ChoreIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    emoji: str = Field("🧹", max_length=8)
    every_days: int = Field(7, ge=1, le=365)
    member_id: int | None = None
    rotate: bool = False


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


class PinIn(BaseModel):
    pin: str


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
    household_size: int | None = Field(None, ge=1, le=50)
    house_name: str | None = Field(None, max_length=60)


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
        "house_name": _house_name(session),
        "vision_model": vision.MODEL,
        "chore_emojis": CHORE_EMOJIS,
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
    if data.house_name is not None:
        session.merge(Setting(key="house_name", value=data.house_name.strip()))
    session.commit()
    return {"household_size": services.household_size(session), "house_name": _house_name(session)}


def _house_name(session: Session) -> str:
    s = session.get(Setting, "house_name")
    return s.value if s and s.value else "Nuestra casa"


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


# ---------------------------------------------------------------- facturas

@app.post("/api/receipts/scan")
async def scan_receipt(photos: list[UploadFile] = File(...), session: Session = SessionDep):
    """Lee la factura con IA. No guarda nada: la familia revisa y confirma."""
    known = [i.name for i in session.exec(select(Ingredient))]
    images = [(await p.read(), p.content_type or "") for p in photos]
    try:
        receipt = vision.scan_receipt(images, known)
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
    db.PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (db.PHOTOS_DIR / name).write_bytes(data)
    item = FamilyPhoto(filename=name, caption=caption.strip()[:80])
    session.add(item)
    session.commit()
    session.refresh(item)
    return _photo_out(item)


@app.get("/api/photos/{photo_id}/file", include_in_schema=False)
def photo_file(photo_id: int, session: Session = SessionDep):
    item = session.get(FamilyPhoto, photo_id)
    path = db.PHOTOS_DIR / item.filename if item else None
    if not path or not path.is_file():
        raise HTTPException(404, "Foto no encontrada")
    return FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.delete("/api/photos/{photo_id}", status_code=204)
def delete_photo(photo_id: int, session: Session = SessionDep):
    item = session.get(FamilyPhoto, photo_id)
    if not item:
        return
    (db.PHOTOS_DIR / item.filename).unlink(missing_ok=True)
    session.delete(item)
    session.commit()


# ---------------------------------------------------------------- hoy y tareas

@app.get("/api/today")
def today(session: Session = SessionDep):
    return household.today_summary(session)


@app.get("/api/members")
def list_members(session: Session = SessionDep):
    return list(household.members_by_id(session).values())


@app.post("/api/members", status_code=201)
def add_member(data: MemberIn, session: Session = SessionDep):
    member = Member(**data.model_dump())
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
    chore = Chore(**data.model_dump())
    session.add(chore)
    session.commit()
    session.refresh(chore)
    return chore


@app.put("/api/chores/{chore_id}")
def update_chore(chore_id: int, data: ChoreIn, session: Session = SessionDep):
    chore = _get_chore(session, chore_id)
    _check_member(session, data.member_id)
    for k, v in data.model_dump().items():
        setattr(chore, k, v)
    session.commit()
    session.refresh(chore)
    return chore


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

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/admin", include_in_schema=False)
def admin():
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

import datetime as dt
import re
from typing import List, Optional

from sqlmodel import Field, Relationship, SQLModel

from .units import convert_with, strip_accents

MEAL_TYPES = ["desayuno", "almuerzo", "cena", "merienda"]
DISH_TYPES = [
    "plato principal", "sopa", "ensalada", "acompañamiento",
    "postre", "bebida", "snack", "salsa", "panadería",
]
INGREDIENT_CATEGORIES = [
    "verduras", "frutas", "carnes", "pescados", "lácteos y huevos", "granos y harinas",
    "legumbres", "especias y condimentos", "aceites y salsas", "enlatados", "panadería",
    "bebidas", "congelados", "aseo y limpieza", "cuidado personal", "hogar", "otros",
]
CHORE_EMOJIS = ["🧹", "🗑️", "🧺", "🍽️", "🪴", "🐶", "🛏️", "🚿", "🧽", "🛒", "💡", "📦"]


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def ingredient_key(name: str) -> str:
    """Clave para reconocer el mismo ingrediente escrito distinto ("Tomates" == "tomate")."""
    key = re.sub(r"\s+", " ", strip_accents(name.strip().lower()))
    words = []
    for w in key.split(" "):
        if len(w) > 4 and w.endswith("es") and w[-3] in "lnrdj":
            w = w[:-2]  # limones -> limon, pero tomates -> tomate
        elif len(w) > 3 and w.endswith("s"):
            w = w[:-1]  # tomates -> tomate
        words.append(w)
    return " ".join(words)


class Ingredient(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    key: str = Field(index=True, unique=True)
    category: str = "otros"
    default_unit: str = "g"
    # Equivalencias propias de la casa para comparar tazas/unidades con gramos
    g_per_ml: Optional[float] = None  # 1 taza (240 ml) de arroz = 200 g -> 0.833
    g_per_unit: Optional[float] = None  # 1 zanahoria = 80 g

    def convert(self, quantity: float, from_unit: str, to_unit: str) -> Optional[float]:
        return convert_with(quantity, from_unit, to_unit, self.g_per_ml, self.g_per_unit)


class PantryItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    ingredient_id: int = Field(foreign_key="ingredient.id", unique=True)
    quantity: float = 0
    unit: str = "g"
    expires_on: Optional[dt.date] = None
    # Si baja de este mínimo pasa sola a la lista de compras (leche, huevos, papel…)
    min_quantity: Optional[float] = None
    updated_at: dt.datetime = Field(default_factory=utcnow)

    ingredient: Ingredient = Relationship()


class Recipe(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    meal_types: str = "almuerzo"  # separados por coma: "almuerzo,cena"
    dish_type: str = "plato principal"
    servings: int = 4  # porciones para las que está escrita la receta
    prep_minutes: Optional[int] = None
    instructions: str = ""
    notes: str = ""
    favorite: bool = False
    created_at: dt.datetime = Field(default_factory=utcnow)

    ingredients: List["RecipeIngredient"] = Relationship(
        back_populates="recipe", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )

    @property
    def meal_type_list(self) -> list[str]:
        return [m for m in self.meal_types.split(",") if m]


class RecipeIngredient(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    recipe_id: int = Field(foreign_key="recipe.id", index=True)
    ingredient_id: int = Field(foreign_key="ingredient.id")
    quantity: float
    unit: str
    note: str = ""  # "picado fino", "al gusto"...
    optional: bool = False

    recipe: Recipe = Relationship(back_populates="ingredients")
    ingredient: Ingredient = Relationship()


class MenuEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    day: dt.date = Field(index=True)
    meal_type: str
    recipe_id: int = Field(foreign_key="recipe.id")
    servings: int
    cooked: bool = False

    recipe: Recipe = Relationship()


class CookLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    recipe_id: int = Field(foreign_key="recipe.id", index=True)
    day: dt.date = Field(default_factory=dt.date.today)
    servings: int


class Setting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str


class Member(SQLModel, table=True):
    """Una persona de la casa."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    emoji: str = "🙂"


class Chore(SQLModel, table=True):
    """Tarea del hogar que se repite cada cierto número de días."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    emoji: str = "🧹"
    every_days: int = 7
    # Persona fija, o None = le toca a cualquiera / por turnos si rotate
    member_id: Optional[int] = Field(default=None, foreign_key="member.id")
    rotate: bool = False
    last_done: Optional[dt.date] = None
    last_done_by: Optional[int] = Field(default=None, foreign_key="member.id")
    created_on: dt.date = Field(default_factory=dt.date.today)


class ChoreLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    chore_id: int = Field(foreign_key="chore.id", index=True)
    member_id: Optional[int] = Field(default=None, foreign_key="member.id")
    day: dt.date = Field(default_factory=dt.date.today)


class Purchase(SQLModel, table=True):
    """Una compra (factura escaneada)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    store: str = ""
    day: dt.date = Field(default_factory=dt.date.today)
    total: Optional[float] = None
    created_at: dt.datetime = Field(default_factory=utcnow)

    items: List["PurchaseItem"] = Relationship(
        back_populates="purchase", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


class PurchaseItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    purchase_id: int = Field(foreign_key="purchase.id", index=True)
    ingredient_id: Optional[int] = Field(default=None, foreign_key="ingredient.id")
    raw_text: str = ""
    name: str
    quantity: float
    unit: str
    price: Optional[float] = None

    purchase: Purchase = Relationship(back_populates="items")


class ShoppingExtra(SQLModel, table=True):
    """Cosas anotadas a mano en la lista ("se acabó el jabón")."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    quantity: Optional[float] = None
    unit: Optional[str] = None
    created_at: dt.datetime = Field(default_factory=utcnow)

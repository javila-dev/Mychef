import datetime as dt
import re
from typing import List, Optional

from sqlmodel import Field, Relationship, SQLModel

from . import clock
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


# Básicos de cocina: se asume que siempre hay (salvo que la casa diga lo contrario).
STAPLE_CATEGORY = "especias y condimentos"
STAPLE_NAMES = [
    "sal", "azúcar", "aceite", "aceite vegetal", "aceite de oliva", "agua", "pimienta", "pimienta negra",
    "comino", "orégano", "laurel", "tomillo", "canela", "paprika", "color", "achiote", "sazón",
    "vinagre", "bicarbonato", "polvo de hornear", "caldo de gallina", "caldo de pollo", "cubo de caldo", "ajo en polvo",
]


class Ingredient(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    key: str = Field(index=True, unique=True)
    category: str = "otros"
    default_unit: str = "g"
    # Equivalencias propias de la casa para comparar tazas/unidades con gramos
    g_per_ml: Optional[float] = None  # 1 taza (240 ml) de arroz = 200 g -> 0.833
    g_per_unit: Optional[float] = None  # 1 zanahoria = 80 g
    # ¿Básico que siempre hay? None = automático (condimentos y la lista STAPLE_NAMES)
    staple: Optional[bool] = None

    @property
    def is_staple(self) -> bool:
        if self.staple is not None:
            return self.staple
        return self.category == STAPLE_CATEGORY or self.key in STAPLE_KEYS

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
    # Idea nueva de la IA que entró al menú: de prueba hasta que la familia diga que le gustó
    # (no cuenta como receta de la casa para planear ni para sugerir)
    trial: bool = False
    # La probaron y no les gustó: la IA no la vuelve a proponer
    disliked: bool = False
    # Nació como idea de la IA (aunque ya sea de la casa): para que aprenda de lo que les gustó
    ai_idea: bool = False
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
    servings: int  # adultos
    kids: int = 0  # niños (comen una porción más pequeña, ver services.kid_portion)
    cooked: bool = False

    recipe: Recipe = Relationship()


class CookLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    recipe_id: int = Field(foreign_key="recipe.id", index=True)
    day: dt.date = Field(default_factory=clock.today)
    servings: int  # adultos
    kids: int = 0


class Setting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str


class Member(SQLModel, table=True):
    """Una persona de la casa."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    emoji: str = "🙂"
    # Niños: sus tareas dan estrellas y tienen su pantalla de logros (ver app/rewards.py)
    kid: bool = False
    # El premio que están juntando, pactado con los papás: «Ir al parque» por 20 estrellas (0 = sin meta)
    goal_name: str = ""
    goal_stars: int = 0
    # Cómo se ve el premio, para los que aún no leen: un ícono a color (app/prize_icons.py) o una foto propia
    goal_icon: str = ""
    goal_photo: str = ""  # archivo en el almacenamiento de fotos
    # (goal_* es del premio único de antes; ahora los premios son una escalera, ver Prize. Se migran solos.)
    # Estrellas ganadas cuando empezó la vuelta actual del camino de premios: avance = ganadas - round_base
    round_base: int = 0


class Chore(SQLModel, table=True):
    """Tarea del hogar que se repite cada cierto número de días."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    emoji: str = "🧹"
    every_days: int = 7
    # Cuándo toca: "every" = cada every_days días; "weekdays" = ciertos días de la semana
    # (weekdays = "0,3" → lunes y jueves; 0 = lunes … 6 = domingo); "monthday" = un día del mes.
    schedule: str = "every"
    weekdays: str = ""
    month_day: Optional[int] = None
    # Recordatorio en voz alta en la tablet, "HH:MM" (hora de la casa)
    remind_at: Optional[str] = None
    # Persona fija, o None = le toca a cualquiera / por turnos si rotate
    member_id: Optional[int] = Field(default=None, foreign_key="member.id")
    rotate: bool = False
    stars: int = 1  # estrellas que gana un niño al hacerla (1 = fácil, 3 = grande)
    last_done: Optional[dt.date] = None
    last_done_by: Optional[int] = Field(default=None, foreign_key="member.id")
    created_on: dt.date = Field(default_factory=clock.today)


class ChoreLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    chore_id: int = Field(foreign_key="chore.id", index=True)
    member_id: Optional[int] = Field(default=None, foreign_key="member.id")
    day: dt.date = Field(default_factory=clock.today)
    stars: int = 1  # las que valía la tarea ese día (si luego cambia, lo ganado no cambia)


class Prize(SQLModel, table=True):
    """Un premio en el camino de estrellas de un niño: se gana al llegar a `stars` (10 → helado, 15 → parque…)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    member_id: int = Field(foreign_key="member.id", index=True)
    name: str
    stars: int  # en qué estrella del camino está
    icon: str = ""  # "fluent-emoji-flat:ice-cream"
    photo: str = ""  # archivo propio (foto o ícono bajado de internet)
    claimed: bool = False  # ya se entregó en esta vuelta


class RewardClaim(SQLModel, table=True):
    """Un premio entregado a un niño (el historial). Entregar no gasta estrellas: el camino sigue."""

    id: Optional[int] = Field(default=None, primary_key=True)
    member_id: int = Field(foreign_key="member.id", index=True)
    name: str
    stars: int
    day: dt.date = Field(default_factory=clock.today)
    prize_id: Optional[int] = None
    # Si con este premio se terminó el camino y empezó otra vuelta: la round_base de antes (para deshacer)
    reset_from: Optional[int] = None


EVENT_CATEGORIES = ["salud", "colegio", "cumpleaños", "pagos", "familia", "otro"]
EVENT_REPEATS = ["none", "weekly", "monthly", "yearly"]


class Event(SQLModel, table=True):
    """Algo de la agenda familiar: una cita médica, una tarea de Benja, un cumpleaños, un pago."""

    id: Optional[int] = Field(default=None, primary_key=True)
    title: str
    category: str = "familia"
    member_id: Optional[int] = Field(default=None, foreign_key="member.id")
    day: dt.date
    time: Optional[str] = None  # "HH:MM"; sin hora = todo el día
    end_day: Optional[dt.date] = None  # lo que dura varios días (un viaje): último día, incluido
    end_time: Optional[str] = None  # "HH:MM" a la que termina (si no, se cuenta una hora)
    notes: str = ""
    repeat: str = "none"  # none | weekly | monthly | yearly
    repeat_until: Optional[dt.date] = None  # se repite hasta este día (incluido)
    skip_days: str = ""  # días que no cuentan (AAAA-MM-DD separados por coma): se canceló o se movió esa vez
    # Cuándo avisar en voz alta: minutos antes, separados por coma (0 = a la hora, 1440 = el día antes)
    remind: str = "60"
    done_on: Optional[dt.date] = None  # para lo que se "entrega" o se cumple una sola vez
    created_at: dt.datetime = Field(default_factory=utcnow)
    # Calendario de Google (ver app/gcal.py)
    google_id: Optional[str] = Field(default=None, index=True)
    google_series: Optional[str] = None  # si es una sola vez de algo que se repite en Google
    google_updated: Optional[str] = None  # la última versión que vimos allá
    sync_dirty: bool = False  # se cambió aquí y falta subirlo


class Purchase(SQLModel, table=True):
    """Una compra (factura escaneada)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    store: str = ""
    day: dt.date = Field(default_factory=clock.today)
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


class FamilyPhoto(SQLModel, table=True):
    """Foto de la familia para el fondo de la pantalla de la casa."""

    id: Optional[int] = Field(default=None, primary_key=True)
    filename: str
    caption: str = ""
    created_at: dt.datetime = Field(default_factory=utcnow)


STAPLE_KEYS = {ingredient_key(n) for n in STAPLE_NAMES}

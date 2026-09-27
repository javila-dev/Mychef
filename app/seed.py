"""Carga unas recetas y una despensa de ejemplo para probar la app.

    python -m app.seed

Son solo para ver cómo funciona: bórrenlas y carguen las suyas.
"""

import datetime as dt

from sqlmodel import Session, select

from . import clock, services
from .db import engine, init_db
from .models import Chore, Member, PantryItem, Recipe

EXAMPLES = [
    {
        "name": "Arepas con huevo", "meal_types": "desayuno", "dish_type": "plato principal",
        "servings": 4, "prep_minutes": 20,
        "instructions": "1. Amasar la harina con el agua tibia y la sal.\n2. Formar 8 arepas y asarlas.\n3. Hacer los huevos pericos con tomate y cebolla.",
        "ingredients": [
            ("Harina de maíz", 2, "taza", "granos y harinas", "", False),
            ("Agua", 2.5, "taza", "bebidas", "tibia", False),
            ("Huevo", 6, "unidad", "lácteos y huevos", "", False),
            ("Tomate", 2, "unidad", "verduras", "picado", False),
            ("Cebolla larga", 1, "unidad", "verduras", "picada", False),
            ("Sal", 1, "cdta", "especias y condimentos", "", False),
        ],
    },
    {
        "name": "Arroz con pollo", "meal_types": "almuerzo,cena", "dish_type": "plato principal",
        "servings": 4, "prep_minutes": 60,
        "instructions": "1. Sofreír cebolla, ajo y pimentón.\n2. Dorar el pollo en cubos.\n3. Agregar arroz, zanahoria y caldo; cocinar tapado 20 min.",
        "notes": "La abuela le pone una pizca de color al final.",
        "ingredients": [
            ("Arroz", 2, "taza", "granos y harinas", "", False),
            ("Pechuga de pollo", 700, "g", "carnes", "en cubos", False),
            ("Zanahoria", 2, "unidad", "verduras", "en cubos", False),
            ("Cebolla", 1, "unidad", "verduras", "picada", False),
            ("Ajo", 3, "diente", "verduras", "machacado", False),
            ("Pimentón", 1, "unidad", "verduras", "", False),
            ("Caldo de pollo", 4, "taza", "otros", "", False),
            ("Cilantro", 0, "pizca", "verduras", "al gusto", True),
        ],
    },
    {
        "name": "Sopa de lentejas", "meal_types": "almuerzo,cena", "dish_type": "sopa",
        "servings": 6, "prep_minutes": 45,
        "instructions": "1. Remojar las lentejas.\n2. Cocinar con papa, zanahoria y hogao hasta que ablanden.",
        "ingredients": [
            ("Lentejas", 500, "g", "legumbres", "", False),
            ("Papa", 3, "unidad", "verduras", "en cubos", False),
            ("Zanahoria", 1, "unidad", "verduras", "", False),
            ("Tomate", 2, "unidad", "verduras", "", False),
            ("Cebolla", 1, "unidad", "verduras", "", False),
        ],
    },
    {
        "name": "Salpicón de frutas", "meal_types": "merienda", "dish_type": "postre",
        "servings": 4, "prep_minutes": 15,
        "instructions": "Picar la fruta, mezclar con el jugo de naranja y servir frío.",
        "ingredients": [
            ("Banano", 2, "unidad", "frutas", "", False),
            ("Papaya", 300, "g", "frutas", "", False),
            ("Naranja", 3, "unidad", "frutas", "en jugo", False),
        ],
    },
]

PANTRY = [
    ("Arroz", 2, "kg", None),
    ("Pechuga de pollo", 1, "kg", 2),
    ("Zanahoria", 4, "unidad", None),
    ("Cebolla", 3, "unidad", None),
    ("Ajo", 10, "diente", None),
    ("Huevo", 12, "unidad", 10),
    ("Tomate", 3, "unidad", 2),
    ("Harina de maíz", 1, "kg", None),
    ("Banano", 4, "unidad", 1),
]


# Equivalencias de la casa: (gramos por taza, gramos por unidad)
EQUIVALENCES = {
    "Arroz": (200, None),
    "Harina de maíz": (130, None),
    "Zanahoria": (None, 80),
    "Pechuga de pollo": (None, 350),
}


MEMBERS = [("Mamá", "👩"), ("Papá", "👨"), ("Sofi", "👧")]
CHORES = [
    # (tarea, emoji, horario, persona fija o None, por turnos, recordar a las)
    # horario: número = cada N días; lista = días de la semana (0 = lunes); "mes:N" = día N del mes
    ("Sacar la basura", "🗑️", [0, 3], None, True, "19:30"),
    ("Lavar la loza", "🍽️", 1, None, True, None),
    ("Regar las plantas", "🪴", [2, 5], "Sofi", False, "17:00"),
    ("Cambiar las sábanas", "🛏️", [5], "Papá", False, None),
    ("Limpiar la nevera", "🧽", "mes:1", None, False, None),
]
MINIMUMS = {"Huevo": 12, "Arroz": 1, "Leche": 2}


class _Line:
    def __init__(self, name, quantity, unit, category, note, optional):
        self.name, self.quantity, self.unit = name, quantity, unit
        self.category, self.note, self.optional = category, note, optional


def main() -> None:
    init_db()
    today = clock.today()
    with Session(engine) as session:
        if session.exec(select(Recipe)).first():
            print("Ya hay recetas; no se cargan ejemplos.")
            return
        for ex in EXAMPLES:
            ingredients = [_Line(*i) for i in ex.pop("ingredients")]
            recipe = Recipe(**ex)
            session.add(recipe)
            session.flush()
            services.set_recipe_ingredients(session, recipe, ingredients)
        for name, qty, unit, days in PANTRY:
            expires = today + dt.timedelta(days=days) if days is not None else None
            services.add_to_pantry(session, name, qty, unit, expires_on=expires)
        services.add_to_pantry(session, "Leche", 1, "l", "lácteos y huevos")
        services.add_to_pantry(session, "Papel higiénico", 4, "unidad", "aseo y limpieza")
        for name, minimum in MINIMUMS.items():
            ing = services.get_or_create_ingredient(session, name)
            item = session.exec(select(PantryItem).where(PantryItem.ingredient_id == ing.id)).one()
            item.min_quantity = minimum  # en la misma unidad en que está guardado
        people = {}
        for name, emoji in MEMBERS:
            people[name] = Member(name=name, emoji=emoji)
            session.add(people[name])
        session.flush()
        for name, emoji, when, who, rotate, remind in CHORES:
            chore = Chore(name=name, emoji=emoji, member_id=people[who].id if who else None,
                          rotate=rotate, remind_at=remind)
            if isinstance(when, list):
                chore.schedule, chore.weekdays = "weekdays", ",".join(map(str, when))
            elif isinstance(when, str):
                chore.schedule, chore.month_day = "monthday", int(when.split(":")[1])
            else:
                chore.every_days = when
            session.add(chore)
        for name, (per_cup, per_unit) in EQUIVALENCES.items():
            ing = services.get_or_create_ingredient(session, name)
            ing.g_per_ml = per_cup / 240 if per_cup else None
            ing.g_per_unit = per_unit
        session.commit()
    print(f"Listo: {len(EXAMPLES)} recetas y {len(PANTRY)} ingredientes de ejemplo.")


if __name__ == "__main__":
    main()

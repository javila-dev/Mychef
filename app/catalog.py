"""Catálogo de lo básico que se compra en una casa de Medellín (plaza, D1, Éxito…).

Se siembra solo al arrancar la app, también en producción: son ingredientes conocidos (nombre,
categoría, unidad y equivalencias) para que las recetas, las fotos del mercado y la lista de compras
los reconozcan desde el primer día. No pone nada en la despensa: qué hay y cuánto lo dice la familia.

Nunca pisa lo que la casa ya cambió: solo crea lo que falta y completa equivalencias vacías. Si se
agregan productos, suban CATALOG_VERSION para que entren en las bases que ya existen.
"""

from sqlmodel import Session, select

from .models import Ingredient, Setting, ingredient_key
from .units import normalize_unit

CATALOG_VERSION = 1

# (nombre, categoría, unidad en que se guarda, gramos por taza, gramos por unidad)
BASICS = [
    # Granos y harinas
    ("Arroz", "granos y harinas", "g", 200, None),
    ("Harina de maíz", "granos y harinas", "g", 130, None),  # la precocida de las arepas
    ("Maíz trillado", "granos y harinas", "g", 180, None),  # para la mazamorra
    ("Harina de trigo", "granos y harinas", "g", 125, None),
    ("Maicena", "granos y harinas", "g", 128, None),
    ("Avena en hojuelas", "granos y harinas", "g", 90, None),
    ("Pasta", "granos y harinas", "g", None, None),
    ("Azúcar", "granos y harinas", "g", 200, None),
    ("Panela", "granos y harinas", "unidad", None, 500),
    # Legumbres
    ("Frijol", "legumbres", "g", 190, None),  # cargamanto
    ("Lentejas", "legumbres", "g", 190, None),
    ("Garbanzo", "legumbres", "g", 200, None),
    ("Arveja seca", "legumbres", "g", 200, None),
    # Verduras
    ("Papa", "verduras", "unidad", None, 150),
    ("Papa criolla", "verduras", "g", None, 30),
    ("Plátano verde", "verduras", "unidad", None, 300),
    ("Plátano maduro", "verduras", "unidad", None, 280),
    ("Yuca", "verduras", "g", None, 500),
    ("Cebolla cabezona", "verduras", "unidad", None, 150),
    ("Cebolla larga", "verduras", "unidad", None, 60),
    ("Tomate", "verduras", "unidad", None, 120),
    ("Ajo", "verduras", "diente", None, None),
    ("Zanahoria", "verduras", "unidad", None, 80),
    ("Pimentón", "verduras", "unidad", None, 160),
    ("Cilantro", "verduras", "atado", None, None),
    ("Mazorca", "verduras", "unidad", None, 250),
    ("Arveja verde", "verduras", "g", 145, None),
    ("Habichuela", "verduras", "g", None, None),
    ("Ahuyama", "verduras", "g", None, None),
    ("Repollo", "verduras", "unidad", None, 1000),
    ("Lechuga", "verduras", "unidad", None, 400),
    ("Pepino", "verduras", "unidad", None, 300),
    ("Remolacha", "verduras", "unidad", None, 150),
    # Frutas
    ("Aguacate", "frutas", "unidad", None, 250),
    ("Limón", "frutas", "unidad", None, 50),
    ("Banano", "frutas", "unidad", None, 120),
    ("Naranja", "frutas", "unidad", None, 200),
    ("Mandarina", "frutas", "unidad", None, 120),
    ("Mango", "frutas", "unidad", None, 300),
    ("Manzana", "frutas", "unidad", None, 180),
    ("Guayaba", "frutas", "unidad", None, 100),
    ("Mora", "frutas", "g", None, None),
    ("Lulo", "frutas", "unidad", None, 80),
    ("Maracuyá", "frutas", "unidad", None, 80),
    ("Tomate de árbol", "frutas", "unidad", None, 90),
    ("Papaya", "frutas", "g", None, None),
    ("Piña", "frutas", "unidad", None, 1500),
    # Carnes y pescados
    ("Pechuga de pollo", "carnes", "g", None, 350),
    ("Pernil de pollo", "carnes", "unidad", None, 250),
    ("Carne molida", "carnes", "g", None, None),
    ("Carne de res", "carnes", "g", None, None),
    ("Lomo de cerdo", "carnes", "g", None, None),
    ("Costilla de cerdo", "carnes", "g", None, None),
    ("Tocino", "carnes", "g", None, None),  # para el chicharrón
    ("Chorizo", "carnes", "unidad", None, 80),
    ("Salchicha", "carnes", "unidad", None, 45),
    ("Tilapia", "pescados", "unidad", None, 400),
    ("Filete de pescado", "pescados", "g", None, None),
    # Lácteos y huevos
    ("Huevo", "lácteos y huevos", "unidad", None, 55),
    ("Leche", "lácteos y huevos", "l", 245, None),
    ("Quesito", "lácteos y huevos", "g", None, None),
    ("Queso mozzarella", "lácteos y huevos", "g", None, None),
    ("Mantequilla", "lácteos y huevos", "g", None, None),
    ("Crema de leche", "lácteos y huevos", "ml", 240, None),
    ("Yogur", "lácteos y huevos", "ml", 245, None),
    ("Kumis", "lácteos y huevos", "ml", 245, None),
    # Panadería
    ("Arepa", "panadería", "unidad", None, 70),
    ("Pan tajado", "panadería", "unidad", None, 25),
    ("Galletas de sal", "panadería", "unidad", None, None),
    # Enlatados
    ("Atún en lata", "enlatados", "unidad", None, 170),
    ("Sardinas en lata", "enlatados", "unidad", None, 425),
    ("Maíz tierno en lata", "enlatados", "unidad", None, 300),
    ("Leche condensada", "enlatados", "g", None, None),
    # Aceites y salsas
    ("Aceite vegetal", "aceites y salsas", "ml", 218, None),
    ("Salsa de tomate", "aceites y salsas", "g", None, None),
    ("Mayonesa", "aceites y salsas", "g", None, None),
    ("Salsa negra", "aceites y salsas", "ml", None, None),
    ("Vinagre", "aceites y salsas", "ml", None, None),
    # Especias y condimentos (son básicos: se asume que siempre hay)
    ("Sal", "especias y condimentos", "g", 290, None),
    ("Pimienta", "especias y condimentos", "g", None, None),
    ("Comino", "especias y condimentos", "g", None, None),
    ("Color", "especias y condimentos", "g", None, None),
    ("Laurel", "especias y condimentos", "unidad", None, None),
    ("Tomillo", "especias y condimentos", "g", None, None),
    ("Orégano", "especias y condimentos", "g", None, None),
    ("Canela", "especias y condimentos", "g", None, None),
    ("Clavos de olor", "especias y condimentos", "g", None, None),
    ("Caldo de gallina", "especias y condimentos", "unidad", None, 10),  # el cubito
    ("Ajo en polvo", "especias y condimentos", "g", None, None),
    ("Bicarbonato", "especias y condimentos", "g", None, None),
    ("Polvo de hornear", "especias y condimentos", "g", None, None),
    # Bebidas
    ("Café", "bebidas", "g", None, None),
    ("Chocolate de mesa", "bebidas", "unidad", None, 31),  # la pastilla
    ("Aromática", "bebidas", "unidad", None, None),
    # Aseo y limpieza
    ("Papel higiénico", "aseo y limpieza", "unidad", None, None),
    ("Jabón de loza", "aseo y limpieza", "unidad", None, None),
    ("Detergente", "aseo y limpieza", "g", None, None),
    ("Blanqueador", "aseo y limpieza", "ml", None, None),  # el límpido
    ("Suavizante", "aseo y limpieza", "ml", None, None),
    ("Limpiapisos", "aseo y limpieza", "ml", None, None),
    ("Esponja", "aseo y limpieza", "unidad", None, None),
    ("Bolsas de basura", "aseo y limpieza", "unidad", None, None),
    ("Servilletas", "aseo y limpieza", "unidad", None, None),
    ("Toallas de cocina", "aseo y limpieza", "unidad", None, None),
    # Cuidado personal
    ("Jabón de baño", "cuidado personal", "unidad", None, None),
    ("Crema dental", "cuidado personal", "unidad", None, None),
    ("Champú", "cuidado personal", "ml", None, None),
    ("Desodorante", "cuidado personal", "unidad", None, None),
    # Hogar
    ("Papel aluminio", "hogar", "unidad", None, None),
    ("Vinipel", "hogar", "unidad", None, None),
]


def seed(session: Session) -> int:
    """Crea los básicos que falten (una vez por versión del catálogo). Devuelve cuántos creó."""
    done = session.get(Setting, "catalog_version")
    if done and done.value.isdigit() and int(done.value) >= CATALOG_VERSION:
        return 0
    existing = {i.key: i for i in session.exec(select(Ingredient))}
    created = 0
    for name, category, unit, per_cup, per_unit in BASICS:
        ing = existing.get(ingredient_key(name))
        if ing is None:
            ing = Ingredient(name=name, key=ingredient_key(name), category=category,
                             default_unit=normalize_unit(unit))
            existing[ing.key] = ing
            created += 1
        elif ing.category == "otros":
            ing.category = category
        # Equivalencias: solo donde la casa no puso las suyas
        if per_cup and ing.g_per_ml is None:
            ing.g_per_ml = per_cup / 240
        if per_unit and ing.g_per_unit is None:
            ing.g_per_unit = per_unit
        session.add(ing)
    done = done or Setting(key="catalog_version", value="")
    done.value = str(CATALOG_VERSION)
    session.add(done)
    session.commit()
    return created

"""Revisar la casa: el repaso de fin de semana de lo que hay, grupo por grupo.

La familia abre la nevera y la alacena, y para cada cosa dice si hay, si queda poco o si se
acabó. Lo que queda poco o se acabó pasa a la lista de compras. Cada grupo se guarda apenas
lo terminan, así nada se pierde si la pantalla vuelve sola al inicio.
"""

from __future__ import annotations

import datetime as dt

from sqlmodel import Session, select

from . import clock, household, services
from .units import normalize_unit
from .models import INGREDIENT_CATEGORIES, PantryItem, Setting, ShoppingExtra, utcnow

# Grupos como los piensa la casa (no las 17 categorías finas de los ingredientes).
# key, nombre, ícono, categorías que junta
GROUPS: list[tuple[str, str, str, list[str]]] = [
    ("proteinas", "Proteínas", "meat", ["carnes", "pescados"]),
    ("lacteos", "Lácteos y huevos", "milk", ["lácteos y huevos"]),
    ("verduras", "Verduras", "carrot", ["verduras"]),
    ("frutas", "Frutas", "apple", ["frutas"]),
    ("granos", "Granos y harinas", "grain", ["granos y harinas", "legumbres"]),
    ("panaderia", "Panadería", "bread", ["panadería"]),
    ("despensa", "Enlatados y salsas", "can", ["enlatados", "aceites y salsas", "especias y condimentos"]),
    ("congelados", "Congelados", "snow", ["congelados"]),
    ("bebidas", "Bebidas", "bottle", ["bebidas"]),
    ("aseo", "Aseo y hogar", "sponge", ["aseo y limpieza", "cuidado personal", "hogar"]),
    ("otros", "Otros", "box", ["otros"]),
]
GROUP_KEYS = {g[0] for g in GROUPS}
CATEGORY_GROUP = {c: g[0] for g in GROUPS for c in g[3]}
assert set(CATEGORY_GROUP) == set(INGREDIENT_CATEGORIES), "cada categoría debe tener su grupo"

STATES = ("ok", "low", "out")
# A partir de cuántos días sin revisar se le recuerda a la casa.
DUE_DAYS = 6


def group_of(category: str) -> str:
    return CATEGORY_GROUP.get(category, "otros")


def _reviewed(session: Session, group: str | None = None) -> dt.date | None:
    s = session.get(Setting, f"inventory_reviewed:{group}" if group else "inventory_reviewed")
    try:
        return dt.date.fromisoformat(s.value) if s else None
    except ValueError:
        return None


def last_review(session: Session) -> dict:
    """Cuándo se revisó la casa por última vez y si ya toca (para el botón del inicio)."""
    day = _reviewed(session)
    days = (clock.today() - day).days if day else None
    return {"reviewed_on": day.isoformat() if day else None, "days_ago": days,
            "due": days is None or days >= DUE_DAYS}


def overview(session: Session, pantry_out) -> dict:
    """Los grupos con sus cosas, en el orden de la casa. pantry_out convierte cada PantryItem."""
    listed = {services.ingredient_key(e.name) for e in session.exec(select(ShoppingExtra))}
    items = []
    for p in session.exec(select(PantryItem)):
        out = pantry_out(p)
        out["in_list"] = p.ingredient.key in listed
        items.append(out)
    items.sort(key=lambda i: i["name"].lower())
    today = clock.today()
    groups = []
    for key, label, icon, categories in GROUPS:
        mine = [i for i in items if group_of(i["category"]) == key]
        day = _reviewed(session, key)
        groups.append({
            "key": key, "label": label, "icon": icon, "categories": categories,
            "items": mine,
            "count": sum(1 for i in mine if i["quantity"] > 0),
            "out": sum(1 for i in mine if i["quantity"] <= 0),
            "reviewed_on": day.isoformat() if day else None,
            "reviewed_today": day == today,
        })
    return {"groups": groups, **last_review(session)}


def _note_in_list(session: Session, name: str) -> None:
    key = services.ingredient_key(name)
    if not any(services.ingredient_key(e.name) == key for e in session.exec(select(ShoppingExtra))):
        session.add(ShoppingExtra(name=name))


def save_group(session: Session, group: str, changes: list) -> dict:
    """Guarda la revisión de un grupo.

    changes trae solo lo que la familia tocó: ok (hay; con cantidad si la corrigieron),
    low (queda poco: a la lista) y out (se acabó: en cero y a la lista). Lo que no tocaron
    queda como estaba, pero se da por visto.
    """
    to_list = []
    for ch in changes:
        item = session.get(PantryItem, ch.id)
        if item is None or group_of(item.ingredient.category) != group:
            continue
        name = item.ingredient.name
        if ch.quantity is not None:
            item.quantity = ch.quantity
        if ch.unit:
            item.unit = normalize_unit(ch.unit)
        if ch.state == "out":
            item.quantity = 0
        if ch.state in ("low", "out"):
            _note_in_list(session, name)
            to_list.append(name)
        else:
            household._clear_extras_for(session, name)  # ya hay: sale de la lista
        item.updated_at = utcnow()
        session.add(item)
    # Lo que no tocaron también se revisó: queda con la fecha de hoy.
    for item in session.exec(select(PantryItem)):
        if group_of(item.ingredient.category) == group:
            item.updated_at = utcnow()
            session.add(item)
    today = clock.today().isoformat()
    session.merge(Setting(key=f"inventory_reviewed:{group}", value=today))
    session.merge(Setting(key="inventory_reviewed", value=today))
    return {"group": group, "to_list": to_list}

"""Sobras: comida ya hecha que quedó en la nevera o en el congelador (frijoles, bolognesa, arroz de pollo).

Se anotan a mano («Guardé sobras»), se ponen en una comida del menú, solas o al lado de una receta,
y al comerlas se descuentan las porciones. No gastan la despensa ni pasan a la lista de compras.
En la nevera duran poco: a partir de FRIDGE_DAYS días la pantalla de la casa avisa.
"""

from __future__ import annotations

import datetime as dt

from sqlmodel import Session, select

from . import clock
from .models import LEFTOVER_PLACES, Leftover, MenuLeftover

FRIDGE_DAYS = 3  # en la nevera, desde el tercer día: «ojo con esto»
FREEZER_DAYS = 90  # en el congelador aguanta, pero no para siempre


def valid_place(place: str) -> bool:
    return place in LEFTOVER_PLACES


def days_old(left: Leftover, today: dt.date | None = None) -> int:
    return ((today or clock.today()) - left.made_on).days


def is_old(left: Leftover, today: dt.date | None = None) -> bool:
    return days_old(left, today) >= (FRIDGE_DAYS if left.place == "nevera" else FREEZER_DAYS)


def planned(session: Session, today: dt.date | None = None,
            exclude: set[tuple[dt.date, str]] | None = None) -> dict[int, float]:
    """Porciones de cada sobra que ya están en el menú y no se han comido (de hoy en adelante)."""
    today = today or clock.today()
    exclude = exclude or set()
    out: dict[int, float] = {}
    for p in session.exec(select(MenuLeftover).where(MenuLeftover.eaten == False, MenuLeftover.day >= today)):  # noqa: E712
        if (p.day, p.meal_type) in exclude:
            continue
        out[p.leftover_id] = out.get(p.leftover_id, 0.0) + p.portions
    return out


def leftover_out(left: Leftover, today: dt.date | None = None, in_menu: float = 0.0) -> dict:
    return {
        "id": left.id,
        "name": left.name,
        "recipe_id": left.recipe_id,
        "portions": round(left.portions, 2),
        "place": left.place,
        "made_on": left.made_on.isoformat(),
        "days": days_old(left, today),
        "old": is_old(left, today),
        "in_menu": round(in_menu, 2),  # ya puestas en el menú
        "free": round(max(0.0, left.portions - in_menu), 2),  # las que quedan para poner
    }


def available(session: Session, today: dt.date | None = None,
              exclude: set[tuple[dt.date, str]] | None = None) -> list[dict]:
    """Las sobras que hay: primero las de la nevera (se dañan antes), las más viejas arriba."""
    today = today or clock.today()
    busy = planned(session, today, exclude)
    rows = session.exec(select(Leftover).where(Leftover.portions > 0)).all()
    rows = sorted(rows, key=lambda x: (x.place != "nevera", x.made_on, x.name.lower()))
    return [leftover_out(x, today, busy.get(x.id, 0.0)) for x in rows]


def plate_out(p: MenuLeftover, today: dt.date | None = None) -> dict:
    return {
        "id": p.id,
        "day": p.day.isoformat(),
        "meal_type": p.meal_type,
        "portions": round(p.portions, 2),
        "eaten": p.eaten,
        "leftover": leftover_out(p.leftover, today),
    }


def plates(session: Session, start: dt.date, end: dt.date) -> list[MenuLeftover]:
    return list(session.exec(
        select(MenuLeftover).where(MenuLeftover.day >= start, MenuLeftover.day <= end).order_by(MenuLeftover.day)))


def eat(session: Session, plate: MenuLeftover) -> None:
    """Se comieron: se descuentan de lo guardado (si no alcanzaba, queda en cero)."""
    left = plate.leftover
    left.portions = max(0.0, round(left.portions - plate.portions, 2))
    plate.eaten = True
    session.add(left)
    session.add(plate)


def uneat(session: Session, plate: MenuLeftover) -> None:
    """Un toque equivocado: vuelven a estar guardadas."""
    left = plate.leftover
    left.portions = round(left.portions + plate.portions, 2)
    plate.eaten = False
    session.add(left)
    session.add(plate)


def eat_with_meal(session: Session, day: dt.date, meal: str) -> list[str]:
    """Al cocinar una comida, las sobras que iban al lado también se comieron."""
    names = []
    for p in session.exec(select(MenuLeftover).where(
            MenuLeftover.day == day, MenuLeftover.meal_type == meal, MenuLeftover.eaten == False)):  # noqa: E712
        eat(session, p)
        names.append(p.leftover.name)
    return names


def finish(session: Session, left: Leftover) -> int:
    """Se acabaron o se botaron: quedan en cero y salen del menú lo que no se había comido."""
    left.portions = 0
    session.add(left)
    removed = 0
    for p in session.exec(select(MenuLeftover).where(MenuLeftover.leftover_id == left.id, MenuLeftover.eaten == False)):  # noqa: E712
        session.delete(p)
        removed += 1
    return removed


def clear_slots(session: Session, slots: set[tuple[dt.date, str]]) -> None:
    """Para rehacer comidas: se quitan las sobras que tenían y no se habían comido."""
    for day, meal in slots:
        for p in session.exec(select(MenuLeftover).where(
                MenuLeftover.day == day, MenuLeftover.meal_type == meal, MenuLeftover.eaten == False)):  # noqa: E712
            session.delete(p)

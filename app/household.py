"""Tareas del hogar, compras (facturas), mínimos de inventario y el resumen de "Hoy"."""

from __future__ import annotations

import datetime as dt

from sqlmodel import Session, select

from . import services
from .models import (
    Chore,
    ChoreLog,
    MenuEntry,
    Member,
    PantryItem,
    Purchase,
    PurchaseItem,
    Recipe,
    ShoppingExtra,
)
from .units import normalize_unit

# ---------------------------------------------------------------- tareas


def members_by_id(session: Session) -> dict[int, Member]:
    return {m.id: m for m in session.exec(select(Member).order_by(Member.id))}


def next_member(chore: Chore, members: list[Member]) -> Member | None:
    """A quién le toca: la persona fija, o la siguiente en el turno."""
    if chore.member_id:
        return next((m for m in members if m.id == chore.member_id), None)
    if not chore.rotate or not members:
        return None
    ids = [m.id for m in members]
    if chore.last_done_by in ids:
        return members[(ids.index(chore.last_done_by) + 1) % len(members)]
    return members[0]


def due_date(chore: Chore) -> dt.date:
    if chore.last_done is None:
        return chore.created_on
    return chore.last_done + dt.timedelta(days=max(chore.every_days, 1))


def chore_out(chore: Chore, members: list[Member], today: dt.date) -> dict:
    due = due_date(chore)
    who = next_member(chore, members)
    by = next((m for m in members if m.id == chore.last_done_by), None)
    return {
        "id": chore.id,
        "name": chore.name,
        "emoji": chore.emoji,
        "every_days": chore.every_days,
        "member_id": chore.member_id,
        "rotate": chore.rotate,
        "due_on": due.isoformat(),
        "days_late": max((today - due).days, 0),
        "is_due": due <= today,
        "done_today": chore.last_done == today,
        "last_done": chore.last_done.isoformat() if chore.last_done else None,
        "last_done_by": {"id": by.id, "name": by.name, "emoji": by.emoji} if by else None,
        "turn": {"id": who.id, "name": who.name, "emoji": who.emoji} if who else None,
    }


def list_chores(session: Session, today: dt.date | None = None) -> list[dict]:
    today = today or dt.date.today()
    members = list(members_by_id(session).values())
    out = [chore_out(c, members, today) for c in session.exec(select(Chore))]
    out.sort(key=lambda c: (not c["is_due"], c["due_on"], c["name"]))
    return out


def complete_chore(
    session: Session, chore: Chore, member_id: int | None, today: dt.date | None = None
) -> None:
    today = today or dt.date.today()
    chore.last_done = today
    chore.last_done_by = member_id
    session.add(chore)
    session.add(ChoreLog(chore_id=chore.id, member_id=member_id, day=today))
    session.flush()


def chore_stats(session: Session, days: int = 30, today: dt.date | None = None) -> list[dict]:
    """Cuántas tareas hizo cada persona en los últimos días (para repartir mejor)."""
    today = today or dt.date.today()
    since = today - dt.timedelta(days=days)
    counts: dict[int | None, int] = {}
    for log in session.exec(select(ChoreLog).where(ChoreLog.day >= since)):
        counts[log.member_id] = counts.get(log.member_id, 0) + 1
    return [
        {"id": m.id, "name": m.name, "emoji": m.emoji, "done": counts.get(m.id, 0)}
        for m in members_by_id(session).values()
    ]


# ---------------------------------------------------------------- inventario bajo


def low_stock(session: Session) -> list[dict]:
    out = []
    for item in session.exec(select(PantryItem).where(PantryItem.min_quantity != None)):  # noqa: E711
        if item.quantity < item.min_quantity:
            out.append({
                "pantry_id": item.id,
                "ingredient_id": item.ingredient_id,
                "name": item.ingredient.name,
                "category": item.ingredient.category,
                "quantity": item.quantity,
                "min_quantity": item.min_quantity,
                "unit": item.unit,
                # comprar lo que falta para volver al mínimo, al menos una unidad
                "to_buy": round(max(item.min_quantity - item.quantity, 0), 2),
            })
    out.sort(key=lambda i: (i["category"], i["name"]))
    return out


def full_shopping_list(session: Session, start: dt.date, end: dt.date) -> list[dict]:
    """Menú + lo que se está acabando + lo anotado a mano, sin repetir ingredientes."""
    items = [{**i, "reason": "menu"} for i in services.shopping_list(session, start, end)]
    in_list = {i["ingredient_id"] for i in items}
    for low in low_stock(session):
        if low["ingredient_id"] in in_list:
            continue
        items.append({
            "ingredient_id": low["ingredient_id"],
            "name": low["name"],
            "category": low["category"],
            "quantity": low["to_buy"],
            "unit": low["unit"],
            "recipes": [],
            "reason": "se acaba",
        })
    for extra in session.exec(select(ShoppingExtra).order_by(ShoppingExtra.created_at)):
        items.append({
            "extra_id": extra.id,
            "ingredient_id": None,
            "name": extra.name,
            "category": "anotado",
            "quantity": extra.quantity,
            "unit": extra.unit,
            "recipes": [],
            "reason": "anotado",
        })
    return items


# ---------------------------------------------------------------- facturas


def save_purchase(
    session: Session,
    store: str,
    day: dt.date | None,
    total: float | None,
    lines: list,
) -> tuple[Purchase, list[PantryItem]]:
    """Guarda la compra y suma cada producto al inventario."""
    purchase = Purchase(store=store or "", day=day or dt.date.today(), total=total)
    session.add(purchase)
    session.flush()
    added = []
    for line in lines:
        item = services.add_to_pantry(
            session, line.name, line.quantity, line.unit, line.category,
            expires_on=getattr(line, "expires_on", None),
        )
        added.append(item)
        session.add(PurchaseItem(
            purchase_id=purchase.id,
            ingredient_id=item.ingredient_id,
            raw_text=getattr(line, "raw_text", "") or "",
            name=item.ingredient.name,
            quantity=line.quantity,
            unit=normalize_unit(line.unit),
            price=getattr(line, "price", None),
        ))
        _clear_extras_for(session, item.ingredient.name)
    session.flush()
    return purchase, added


def _clear_extras_for(session: Session, name: str) -> None:
    """Si se compró algo que estaba anotado a mano en la lista, se tacha solo."""
    key = services.ingredient_key(name)
    for extra in session.exec(select(ShoppingExtra)):
        if services.ingredient_key(extra.name) == key:
            session.delete(extra)


def spending(session: Session, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    month_start = today.replace(day=1)
    purchases = session.exec(select(Purchase).order_by(Purchase.day.desc())).all()
    month = [p for p in purchases if p.day >= month_start]
    return {
        "month_total": round(sum(p.total or 0 for p in month), 2),
        "month_count": len(month),
        "recent": [
            {"id": p.id, "store": p.store, "day": p.day.isoformat(), "total": p.total,
             "items": len(p.items)}
            for p in purchases[:10]
        ],
    }


# ---------------------------------------------------------------- hoy


def today_summary(session: Session, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    menu = session.exec(select(MenuEntry).where(MenuEntry.day == today)).all()
    pantry = services.load_pantry(session)
    meals = []
    for e in sorted(menu, key=lambda e: services.MEAL_ORDER.get(e.meal_type, 9)):
        avail = services.check_availability(e.recipe, e.servings, pantry)
        meals.append({
            "id": e.id,
            "meal_type": e.meal_type,
            "servings": e.servings,
            "cooked": e.cooked,
            "can_cook": avail["can_cook"],
            "missing": [i["name"] for i in avail["items"]
                        if i["status"] in ("falta", "poco") and not i["optional"]],
            "recipe": services.recipe_summary(e.recipe),
        })
    expiring = []
    for item in session.exec(select(PantryItem).where(PantryItem.expires_on != None)):  # noqa: E711
        days_left = (item.expires_on - today).days
        if item.quantity > 0 and days_left <= services.EXPIRING_DAYS:
            expiring.append({"name": item.ingredient.name, "days_left": days_left})
    expiring.sort(key=lambda i: i["days_left"])
    chores = [c for c in list_chores(session, today) if c["is_due"] or c["done_today"]]
    week_start = today - dt.timedelta(days=today.weekday())
    shopping = full_shopping_list(session, week_start, week_start + dt.timedelta(days=6))
    counts = {
        name: len(session.exec(select(model)).all())
        for name, model in (("recipes", Recipe), ("members", Member), ("chores", Chore),
                            ("pantry", PantryItem))
    }
    return {
        "date": today.isoformat(),
        "setup": counts,
        "meals": meals,
        "expiring": expiring,
        "chores": chores,
        "shopping_count": len(shopping),
        "low_stock": [i["name"] for i in low_stock(session)],
        "members": [
            {"id": m.id, "name": m.name, "emoji": m.emoji}
            for m in members_by_id(session).values()
        ],
    }


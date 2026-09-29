"""Logros de los niños: estrellas por sus tareas, un premio pactado que van juntando, insignias y racha.

Cómo está pensado (lo que recomiendan para motivar a niños con las tareas de la casa):
- Economía de fichas: cada tarea hecha da estrellas al momento, visibles y concretas.
- Metas cercanas y pactadas con los papás, en escalera sobre un mismo camino de estrellas: a las 10 un
  helado, a las 15 el parque, a las 20 la bici. Mejor experiencias que cosas.
- Nunca se quitan estrellas: entregar un premio no las gasta, el camino sigue. Al entregar el último,
  empieza otra vuelta con los mismos premios (lo que sobró pasa a la vuelta nueva). Todo se puede
  deshacer si fue un toque por error.
- Racha que perdona: un día sin tareas no la rompe; se rompe solo con dos días seguidos sin nada.
- Insignias por hitos (la primera tarea, 20 tareas, una semana de racha…) y niveles que crecen con
  las estrellas ganadas en total, que nunca bajan aunque se canjeen premios.
"""

from __future__ import annotations

import datetime as dt

from sqlmodel import Session, select

from . import clock, household, prize_icons
from .models import ChoreLog, Member, Prize, RewardClaim

# (id, nombre, ícono, qué hay que hacer, métrica, meta)
BADGES = [
    ("first", "Primera estrella", "star", "Hacer la primera tarea", "tasks", 1),
    ("five", "¡Ya van cinco!", "check", "Hacer 5 tareas", "tasks", 5),
    ("streak3", "Tres días seguidos", "sun", "Ayudar 3 días seguidos", "best_streak", 3),
    ("variety", "Todoterreno", "broom", "Hacer 3 tareas distintas", "variety", 3),
    ("twenty", "Gran ayudante", "heart", "Hacer 20 tareas", "tasks", 20),
    ("streak7", "Una semana entera", "calendar", "Ayudar 7 días seguidos", "best_streak", 7),
    ("prize", "Primer premio", "cake", "Canjear un premio", "claims", 1),
    ("fifty", "Estrella de la casa", "home", "Ganar 50 estrellas", "earned", 50),
    ("streak30", "Un mes sin parar", "moon", "Ayudar 30 días seguidos", "best_streak", 30),
    ("hundred", "Leyenda del hogar", "spark", "Ganar 100 estrellas", "earned", 100),
]

# Niveles por estrellas ganadas en total (nunca bajan).
LEVELS = [
    (0, "Aprendiz"), (10, "Ayudante"), (25, "Buen ayudante"), (50, "Gran ayudante"),
    (80, "Experto de la casa"), (120, "Capitán del hogar"), (180, "Leyenda"),
]

# Dibujos a color de los premios: ver app/prize_icons.py. Nombres viejos (íconos de trazo) → los nuevos.
LEGACY_ICONS = {
    "icecream": "ice-cream", "park": "playground-slide", "movie": "popcorn", "pizza": "pizza",
    "pool": "person-swimming", "bike": "bicycle", "cookie": "cookie", "game": "video-game", "tent": "tent",
    "ball": "teddy-bear", "cake": "birthday-cake", "book": "open-book",
}


def prize_art(prize: Prize) -> tuple[str | None, str | None]:
    """(url, "photo" | "icon") de la imagen del premio: su archivo propio o uno de los íconos de la app."""
    icon = LEGACY_ICONS.get(prize.icon, None)
    icon = f"fluent-emoji-flat:{icon}" if icon else prize.icon
    if prize.photo:  # el nombre del archivo cambia con cada imagen: sirve para no ver la vieja
        return (f"/api/kids/{prize.member_id}/prizes/{prize.id}/photo?v={prize.photo.split('.')[0]}",
                "icon" if prize.photo.endswith(".svg") else "photo")
    url = prize_icons.bundled_url(icon)
    return (url, "icon") if url else (None, None)


def prize_out(prize: Prize, progress: int) -> dict:
    art, kind = prize_art(prize)
    return {"id": prize.id, "name": prize.name, "stars": prize.stars, "icon": prize.icon, "art": art, "kind": kind,
            "claimed": prize.claimed, "reached": progress >= prize.stars,
            # «ready»: llegó y falta entregarlo (lo que la tablet celebra)
            "ready": progress >= prize.stars and not prize.claimed}


def prizes_of(session: Session, member: Member) -> list[Prize]:
    return list(session.exec(select(Prize).where(Prize.member_id == member.id).order_by(Prize.stars, Prize.id)))


def _streaks(days: set[dt.date], today: dt.date) -> tuple[int, int]:
    """(racha actual, mejor racha) en días con alguna tarea; un solo día sin tareas no la rompe."""
    if not days:
        return 0, 0
    ordered = sorted(days)
    best = run = 1
    for prev, cur in zip(ordered, ordered[1:]):
        run = run + 1 if (cur - prev).days <= 2 else 1
        best = max(best, run)
    current = run if (today - ordered[-1]).days <= 1 else 0
    return current, best


def _level(earned: int) -> dict:
    idx = max(i for i, (need, _) in enumerate(LEVELS) if earned >= need)
    need, name = LEVELS[idx]
    nxt = LEVELS[idx + 1] if idx + 1 < len(LEVELS) else None
    return {
        "number": idx + 1, "name": name, "from": need,
        "next": nxt[0] if nxt else None, "next_name": nxt[1] if nxt else None,
    }


def kid_chores(session: Session, member: Member, today: dt.date) -> list[dict]:
    """Las tareas del niño que tocan hoy o ya hizo hoy: las suyas fijas y las de turnos cuando le toca."""
    out = []
    for c in household.list_chores(session, today):
        mine = c["member_id"] == member.id or (c["rotate"] and c["turn"] and c["turn"]["id"] == member.id)
        done_by_me = c["done_today"] and c["last_done_by"] and c["last_done_by"]["id"] == member.id
        if (mine and (c["is_due"] or c["done_today"])) or done_by_me:
            out.append(c)
    return out


def summary(session: Session, member: Member, today: dt.date | None = None) -> dict:
    today = today or clock.today()
    logs = session.exec(select(ChoreLog).where(ChoreLog.member_id == member.id)).all()
    claims = session.exec(
        select(RewardClaim).where(RewardClaim.member_id == member.id).order_by(RewardClaim.id)
    ).all()
    earned = sum(log.stars or 1 for log in logs)
    progress = max(earned - (member.round_base or 0), 0)  # dónde va en el camino de premios
    streak, best = _streaks({log.day for log in logs}, today)
    metrics = {
        "tasks": len(logs), "earned": earned, "best_streak": best, "claims": len(claims),
        "variety": len({log.chore_id for log in logs}),
    }
    badges = [
        {"id": bid, "name": name, "icon": ic, "text": text, "target": target,
         "progress": min(metrics[metric], target), "earned": metrics[metric] >= target}
        for bid, name, ic, text, metric, target in BADGES
    ]
    monday = today - dt.timedelta(days=today.weekday())
    per_day: dict[dt.date, int] = {}
    for log in logs:
        per_day[log.day] = per_day.get(log.day, 0) + (log.stars or 1)
    days = [monday + dt.timedelta(days=i) for i in range(7)]
    week = [{"day": d.isoformat(), "stars": per_day.get(d, 0), "today": d == today, "future": d > today}
            for d in days]
    chores = kid_chores(session, member, today)
    prizes = [prize_out(p, progress) for p in prizes_of(session, member)]
    goal = next((p for p in prizes if not p["claimed"]), None)
    return {
        "member": household.person(member),
        "stars": progress,
        "prizes": prizes,
        "path": max((p["stars"] for p in prizes), default=0),  # largo del camino
        "earned": earned,
        "tasks": len(logs),
        "streak": streak,
        "best_streak": best,
        "level": _level(earned),
        "goal": goal,  # el próximo premio sin entregar
        "badges": badges,
        "week": week,
        "chores": chores,
        "today_done": sum(1 for c in chores if c["done_today"]),
        "claims": [{"id": c.id, "name": c.name, "stars": c.stars, "day": c.day.isoformat()} for c in claims[-5:]][::-1],
    }


def kids(session: Session) -> list[Member]:
    return list(session.exec(select(Member).where(Member.kid == True).order_by(Member.id)))  # noqa: E712


def all_summaries(session: Session, today: dt.date | None = None) -> list[dict]:
    return [summary(session, m, today) for m in kids(session)]


def claim(session: Session, member: Member, today: dt.date | None = None) -> RewardClaim | None:
    """Entrega el próximo premio al que ya llegó. Si era el último del camino, empieza otra vuelta."""
    data = summary(session, member, today)
    nxt = data["goal"]
    if not nxt or not nxt["ready"]:
        return None
    prizes = prizes_of(session, member)
    prize = next(p for p in prizes if p.id == nxt["id"])
    prize.claimed = True
    rc = RewardClaim(member_id=member.id, name=prize.name, stars=prize.stars, prize_id=prize.id,
                     day=today or clock.today())
    if all(p.claimed for p in prizes):  # llegó al final: otra vuelta con los mismos premios
        rc.reset_from = member.round_base or 0
        member.round_base = (member.round_base or 0) + max(p.stars for p in prizes)
        for p in prizes:
            p.claimed = False
        session.add(member)
    session.add(rc)
    session.flush()
    return rc


def undo_claim(session: Session, member: Member) -> bool:
    last = session.exec(
        select(RewardClaim).where(RewardClaim.member_id == member.id).order_by(RewardClaim.id.desc())
    ).first()
    if not last:
        return False
    prizes = prizes_of(session, member)
    if last.reset_from is not None:  # se había empezado otra vuelta: se vuelve al final de la anterior
        member.round_base = last.reset_from
        for p in prizes:
            p.claimed = True
        session.add(member)
    prize = next((p for p in prizes if p.id == last.prize_id), None)
    if prize:
        prize.claimed = False
    session.delete(last)
    session.flush()
    return True


def migrate(session: Session) -> None:
    """Del premio único de antes (Member.goal_*) a la escalera de premios. Lo canjeado antes sí gastaba
    estrellas: esa suma pasa a round_base, así cada niño sigue viendo las mismas estrellas."""
    changed = False
    for m in session.exec(select(Member)):
        if not m.goal_name:
            continue
        if not session.exec(select(Prize).where(Prize.member_id == m.id)).first():
            session.add(Prize(member_id=m.id, name=m.goal_name, stars=max(m.goal_stars, 1),
                              icon=m.goal_icon or "", photo=m.goal_photo or ""))
            spent = sum(c.stars for c in session.exec(select(RewardClaim).where(RewardClaim.member_id == m.id)))
            m.round_base = (m.round_base or 0) + spent
        m.goal_name, m.goal_stars, m.goal_icon, m.goal_photo = "", 0, "", ""
        session.add(m)
        changed = True
    if changed:
        session.commit()


def forget_member(session: Session, member_id: int) -> None:
    """Al quitar a una persona: sus premios y lo entregado se van con ella (las fotos las borra quien llama)."""
    for rc in session.exec(select(RewardClaim).where(RewardClaim.member_id == member_id)):
        session.delete(rc)
    for p in session.exec(select(Prize).where(Prize.member_id == member_id)):
        session.delete(p)


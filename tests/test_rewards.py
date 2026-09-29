"""Logros de los niños: estrellas, meta pactada, racha que perdona e insignias."""

import datetime as dt
import json

from app import prize_icons, rewards
from app.db import get_session
from app.main import app
from app.models import ChoreLog, Member


def _kid(client, name="Sofi"):
    m = client.post("/api/members", json={"name": name, "kid": True}).json()
    assert m["kid"] is True
    return m


def _earn(member_id, stars, chore_id):
    """Estrellas de días anteriores, directo en el historial."""
    session = next(app.dependency_overrides[get_session]())
    for back in range(stars):
        session.add(ChoreLog(chore_id=chore_id, member_id=member_id, day=dt.date.today() - dt.timedelta(back + 1), stars=1))
    session.commit()


def _chore(client, member_id, stars=None, name="Regar las plantas"):
    body = {"name": name, "every_days": 1, "member_id": member_id}
    if stars:
        body["stars"] = stars
    return client.post("/api/chores", json=body).json()


def test_only_kids_listed_and_flag_survives_rename(client):
    client.post("/api/members", json={"name": "Mamá"})
    sofi = _kid(client)
    assert [k["member"]["name"] for k in client.get("/api/kids").json()] == ["Sofi"]
    # Cambiar el nombre sin decir nada de «kid» no le quita lo de niña
    client.put(f"/api/members/{sofi['id']}", json={"name": "Sofía"})
    assert client.get("/api/kids").json()[0]["member"]["name"] == "Sofía"
    client.put(f"/api/members/{sofi['id']}", json={"name": "Sofía", "kid": False})
    assert client.get("/api/kids").json() == []


def test_prize_ladder_and_claims(client):
    sofi = _kid(client)
    kid = f"/api/kids/{sofi['id']}"
    c = _chore(client, sofi["id"], stars=3)
    assert c["stars"] == 3
    # Tres premios en el mismo camino, en cualquier orden: quedan ordenados por estrella
    client.post(f"{kid}/prizes", json={"name": "Paseo en bici", "stars": 20})
    client.post(f"{kid}/prizes", json={"name": "Un helado", "stars": 10, "icon": "fluent-emoji-flat:ice-cream"})
    k = client.post(f"{kid}/prizes", json={"name": "Ir al parque", "stars": 15}).json()
    assert [p["stars"] for p in k["prizes"]] == [10, 15, 20] and k["path"] == 20
    assert k["prizes"][0]["art"] == "/static/prizes/fluent-emoji-flat--ice-cream.svg"
    assert k["goal"]["name"] == "Un helado" and not k["goal"]["ready"]
    # Dos premios en la misma estrella no
    assert client.post(f"{kid}/prizes", json={"name": "Otro", "stars": 15}).status_code == 422
    assert client.post(f"{kid}/claim").status_code == 422

    _earn(sofi["id"], 9, c["id"])
    client.post(f"/api/chores/{c['id']}/done", json={"member_id": sofi["id"]})  # +3 → 12
    k = client.get(kid).json()
    assert k["stars"] == 12 and k["goal"]["ready"]
    assert [p["reached"] for p in k["prizes"]] == [True, False, False]

    # Entregar no gasta estrellas: el camino sigue y el próximo es el parque
    k = client.post(f"{kid}/claim").json()
    assert k["stars"] == 12 and k["prizes"][0]["claimed"] and k["goal"]["name"] == "Ir al parque"
    assert k["claims"][0]["name"] == "Un helado"
    assert next(b for b in k["badges"] if b["id"] == "prize")["earned"]

    # Cambiar lo que vale la tarea no cambia lo ya ganado
    client.put(f"/api/chores/{c['id']}", json={"name": "Regar las plantas", "every_days": 1, "member_id": sofi["id"], "stars": 1})
    assert client.get(kid).json()["stars"] == 12
    # Guardar sin decir las estrellas (como lo hace Administrar) las deja como estaban
    client.put(f"/api/chores/{c['id']}", json={"name": "Regar", "every_days": 1, "member_id": sofi["id"]})
    assert client.get("/api/chores").json()[0]["stars"] == 1

    # Llega al final (23 estrellas): entrega el parque y la bici; empieza otra vuelta con 3 que sobraron
    _earn(sofi["id"], 11, c["id"])
    client.post(f"{kid}/claim")
    k = client.post(f"{kid}/claim").json()
    assert k["stars"] == 3 and k["earned"] == 23
    assert not any(p["claimed"] for p in k["prizes"]) and k["goal"]["name"] == "Un helado"
    # Deshacer la última entrega vuelve al final de la vuelta anterior
    k = client.post(f"{kid}/claim/undo").json()
    assert k["stars"] == 23 and [p["claimed"] for p in k["prizes"]] == [True, True, False]
    assert k["goal"]["name"] == "Paseo en bici" and k["goal"]["ready"]
    k = client.post(f"{kid}/claim/undo").json()
    assert [p["claimed"] for p in k["prizes"]] == [True, False, False]


def test_edit_and_delete_prizes(client):
    sofi = _kid(client)
    kid = f"/api/kids/{sofi['id']}"
    k = client.post(f"{kid}/prizes", json={"name": "Helado", "stars": 10}).json()
    pid = k["prizes"][0]["id"]
    k = client.put(f"{kid}/prizes/{pid}", json={"name": "Helado doble", "stars": 12, "icon": "park"}).json()
    assert k["prizes"][0]["name"] == "Helado doble" and k["prizes"][0]["icon"] == "fluent-emoji-flat:playground-slide"
    assert client.put(f"{kid}/prizes/999", json={"name": "X", "stars": 3}).status_code == 404
    assert client.delete(f"{kid}/prizes/{pid}").json()["prizes"] == []
    assert client.get(kid).json()["goal"] is None


def test_old_single_goal_is_migrated(client):
    from app import rewards
    from app.models import RewardClaim
    sofi = _kid(client)
    session = next(app.dependency_overrides[get_session]())
    m = session.get(Member, sofi["id"])
    m.goal_name, m.goal_stars, m.goal_icon = "Ir al parque", 10, "park"
    session.add(RewardClaim(member_id=m.id, name="Helado", stars=5))  # antes, canjear gastaba estrellas
    c = _chore(client, sofi["id"])
    session.commit()
    _earn(sofi["id"], 8, c["id"])
    rewards.migrate(session)
    k = client.get(f"/api/kids/{sofi['id']}").json()
    assert k["stars"] == 3  # 8 ganadas - 5 que gastó: lo mismo que veía antes
    assert [(p["name"], p["stars"]) for p in k["prizes"]] == [("Ir al parque", 10)]
    rewards.migrate(session)  # no duplica
    assert len(client.get(f"/api/kids/{sofi['id']}").json()["prizes"]) == 1


def test_delete_kid_with_prizes(client):
    sofi = _kid(client)
    c = _chore(client, sofi["id"])
    client.post(f"/api/kids/{sofi['id']}/prizes", json={"name": "Helado", "stars": 1})
    client.post(f"/api/chores/{c['id']}/done", json={"member_id": sofi["id"]})
    client.post(f"/api/kids/{sofi['id']}/claim")
    assert client.delete(f"/api/members/{sofi['id']}").status_code == 204
    assert client.get("/api/kids").json() == []


def test_prize_icon_and_photo(client, tmp_path, monkeypatch):
    from app import db
    from tests.test_household import PNG_1PX
    monkeypatch.setattr(db, "PHOTOS_DIR", tmp_path / "photos")
    photos = lambda: list((tmp_path / "photos").iterdir()) if (tmp_path / "photos").exists() else []  # noqa: E731
    benja = _kid(client, "Benja")
    kid = f"/api/kids/{benja['id']}"
    pid = client.post(f"{kid}/prizes", json={"name": "Un helado", "stars": 10, "icon": "fluent-emoji-flat:ice-cream"}).json()["prizes"][0]["id"]
    one = f"{kid}/prizes/{pid}"
    assert client.put(one, json={"name": "X", "stars": 10, "icon": "<script>"}).status_code == 422
    # Una foto reemplaza al ícono
    assert client.post(f"{one}/photo", files={"photo": ("x.gif", b"GIF89a", "image/gif")}).status_code == 400
    p = client.post(f"{one}/photo", files={"photo": ("helado.png", PNG_1PX, "image/png")}).json()["prizes"][0]
    assert p["kind"] == "photo" and client.get(p["art"]).content == PNG_1PX
    # Guardar sin ícono deja la foto
    p = client.put(one, json={"name": "Un helado", "stars": 12}).json()["prizes"][0]
    assert p["kind"] == "photo" and len(photos()) == 1
    # Un ícono buscado en internet se baja y se guarda (y borra la foto)
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle r="9" fill="#f90"/></svg>'
    monkeypatch.setattr(prize_icons, "_get", lambda url, timeout=8: svg)
    p = client.put(one, json={"name": "Un helado", "stars": 12, "icon": "noto:ice-cream"}).json()["prizes"][0]
    assert p["kind"] == "icon" and len(photos()) == 1
    got = client.get(p["art"])
    assert got.content == svg and got.headers["content-type"].startswith("image/svg+xml")
    assert "default-src 'none'" in got.headers["content-security-policy"]
    # Quitar el premio borra su imagen
    client.delete(one)
    assert photos() == []
    assert any(x["url"] for x in client.get("/api/meta").json()["prizes"])


def test_undo_chore_takes_back_the_star(client):
    sofi = _kid(client)
    c = _chore(client, sofi["id"])
    client.post(f"/api/chores/{c['id']}/done", json={"member_id": sofi["id"]})
    assert client.get(f"/api/kids/{sofi['id']}").json()["stars"] == 1
    client.post(f"/api/chores/{c['id']}/undo")
    k = client.get(f"/api/kids/{sofi['id']}").json()
    assert k["stars"] == 0 and not k["badges"][0]["earned"]


def test_streak_forgives_one_day():
    d = dt.date(2026, 9, 1)
    days = {d, d + dt.timedelta(1), d + dt.timedelta(3), d + dt.timedelta(4)}  # falta el día 3
    assert rewards._streaks(days, d + dt.timedelta(4)) == (4, 4)
    assert rewards._streaks(days, d + dt.timedelta(5)) == (4, 4)  # hoy aún puede ayudar
    assert rewards._streaks(days, d + dt.timedelta(6)) == (0, 4)  # dos días sin nada: se rompe
    later = days | {d + dt.timedelta(8)}
    assert rewards._streaks(later, d + dt.timedelta(8)) == (1, 4)
    assert rewards._streaks(set(), d) == (0, 0)


def test_week_chart_and_level(client):
    sofi = _kid(client)
    c = _chore(client, sofi["id"], stars=2)
    session = next(app.dependency_overrides[get_session]())
    today = dt.date.today()
    for back in range(12):  # 12 días seguidos, 2 estrellas cada uno
        session.add(ChoreLog(chore_id=c["id"], member_id=sofi["id"], day=today - dt.timedelta(back), stars=2))
    session.commit()
    k = rewards.summary(session, session.get(Member, sofi["id"]), today)
    assert k["streak"] == 12 and k["earned"] == 24
    assert k["level"]["name"] == "Ayudante" and k["level"]["next"] == 25
    assert sum(d["stars"] for d in k["week"] if not d["future"]) == 2 * (today.weekday() + 1)
    assert next(b for b in k["badges"] if b["id"] == "streak7")["earned"]


def test_prize_icon_search_translates_and_filters(client, monkeypatch):
    asked = []

    def fake_get(url, timeout=8):
        asked.append(url)
        return json.dumps({"icons": [
            "noto:ice-cream", "fluent-emoji-flat:ice-cream", "fluent-emoji-flat:person-swimming-light",
            "fluent-emoji-flat:soft-ice-cream", "mdi:ice-cream",
        ]}).encode()

    monkeypatch.setattr(prize_icons, "_get", fake_get)
    res = client.get("/api/prize-icons", params={"q": "Helados"}).json()
    assert res["query"] == "ice cream" and "ice+cream" in asked[0]
    # Primero Fluent, sin repetidos, sin tonos de piel ni colecciones de un solo color
    assert [i["icon"] for i in res["icons"]] == ["fluent-emoji-flat:ice-cream", "fluent-emoji-flat:soft-ice-cream"]
    assert res["icons"][0]["url"].startswith("/static/prizes/")  # el que viene con la app no sale de internet

    def offline(url, timeout=8):
        raise OSError("sin red")

    monkeypatch.setattr(prize_icons, "_get", offline)
    assert client.get("/api/prize-icons", params={"q": "parque"}).status_code == 502


def test_prize_svg_is_checked(monkeypatch):
    import pytest
    for bad in (b"<svg><script>alert(1)</script></svg>", b'<svg onload="x()"></svg>', b"<html></html>"):
        monkeypatch.setattr(prize_icons, "_get", lambda url, timeout=8, b=bad: b)
        with pytest.raises(ValueError):
            prize_icons.download("noto:ice-cream")
    with pytest.raises(ValueError):
        prize_icons.download("../../etc")


def test_translate_spanish_words():
    assert prize_icons.translate("Parques") == "playground|national park|tree"
    assert prize_icons.translate("Helado de chocolate") == "ice cream chocolate"
    assert prize_icons.translate("montaña rusa") == "roller coaster"
    assert prize_icons.translate("unicorn") == "unicorn"  # en inglés pasa igual


def test_search_tries_each_option(monkeypatch):
    asked = []

    def fake_get(url, timeout=8):
        asked.append(url)
        return json.dumps({"icons": ["fluent-emoji-flat:t-rex"] if "t-rex" in url else ["fluent-emoji-flat:sauropod"]}).encode()

    monkeypatch.setattr(prize_icons, "_get", fake_get)
    assert prize_icons.search("dinosaurio") == ["fluent-emoji-flat:t-rex", "fluent-emoji-flat:sauropod"]
    assert len(asked) == 2

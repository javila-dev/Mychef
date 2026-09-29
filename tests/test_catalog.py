from sqlalchemy.pool import StaticPool
from sqlmodel import Session, create_engine, select

from app import catalog
from app.db import init_db
from app.models import INGREDIENT_CATEGORIES, Ingredient, PantryItem, ingredient_key
from app.units import UNITS, normalize_unit


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    init_db(engine)
    return Session(engine)


def test_catalog_is_consistent():
    keys = [ingredient_key(n) for n, *_ in catalog.BASICS]
    assert len(keys) == len(set(keys)), "hay dos productos que la app confunde"
    for name, category, unit, per_cup, per_unit in catalog.BASICS:
        assert category in INGREDIENT_CATEGORIES, name
        assert normalize_unit(unit) == unit, name
        if per_cup:
            assert UNITS[unit][0] != "conteo", name


def test_seed_creates_basics_once_and_respects_the_house():
    with _session() as s:
        arroz = Ingredient(name="Arroz", key="arroz", category="otros", g_per_ml=0.9)
        s.add(arroz)
        s.commit()

        created = catalog.seed(s)
        assert created == len(catalog.BASICS) - 1
        s.refresh(arroz)
        assert arroz.category == "granos y harinas"  # lo completa
        assert arroz.g_per_ml == 0.9  # pero no pisa la equivalencia de la casa
        assert not s.exec(select(PantryItem)).first()  # no inventa lo que hay en la despensa

        # Lo que la familia borra no vuelve a aparecer en el próximo arranque
        s.delete(s.exec(select(Ingredient).where(Ingredient.key == "vinipel")).one())
        s.commit()
        assert catalog.seed(s) == 0
        assert not s.exec(select(Ingredient).where(Ingredient.key == "vinipel")).first()

        sal = s.exec(select(Ingredient).where(Ingredient.key == "sal")).one()
        assert sal.is_staple

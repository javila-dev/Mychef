import os
from pathlib import Path

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

DB_PATH = os.environ.get("MYCHEF_DB", str(Path(__file__).resolve().parent.parent / "data" / "mychef.db"))

Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
PHOTOS_DIR = Path(os.environ.get("MYCHEF_PHOTOS", str(Path(DB_PATH).parent / "photos")))
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def init_db(eng=engine) -> None:
    from . import models  # noqa: F401  (registra las tablas)

    SQLModel.metadata.create_all(eng)
    _add_missing_columns(eng)


def _add_missing_columns(eng) -> None:
    """Migración mínima: agrega columnas nuevas a bases de datos de versiones anteriores."""
    insp = inspect(eng)
    with eng.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    coltype = col.type.compile(dialect=eng.dialect)
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}'))


def get_session():
    with Session(engine) as session:
        yield session

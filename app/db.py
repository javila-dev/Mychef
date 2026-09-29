"""Base de datos: SQLite por defecto (un archivo, nada que instalar) o PostgreSQL si se configura
MYCHEF_DATABASE_URL (o DATABASE_URL), p. ej. postgresql://usuario:clave@servidor:5432/mychef."""

import os
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = os.environ.get("MYCHEF_DB", str(DATA_DIR / "mychef.db"))
DATABASE_URL = os.environ.get("MYCHEF_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""


def normalize_url(url: str) -> str:
    """postgres:// y postgresql:// usan el controlador psycopg 3."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


if DATABASE_URL:
    engine = create_engine(normalize_url(DATABASE_URL), pool_pre_ping=True)
    default_photos = DATA_DIR / "photos"
else:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
    default_photos = Path(DB_PATH).parent / "photos"

# Las fotos de la familia son archivos, también con PostgreSQL.
PHOTOS_DIR = Path(os.environ.get("MYCHEF_PHOTOS", str(default_photos)))


def init_db(eng=engine) -> None:
    from . import models  # noqa: F401  (registra las tablas)

    SQLModel.metadata.create_all(eng)
    _add_missing_columns(eng)
    from . import rewards  # noqa: PLC0415 (evita importar la app entera al cargar db)

    with Session(eng) as session:
        rewards.migrate(session)


def _add_missing_columns(eng) -> None:
    """Migración mínima: agrega columnas nuevas a bases de datos de versiones anteriores,
    con su valor por defecto para las filas que ya existían."""
    insp = inspect(eng)
    with eng.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                coltype = col.type.compile(dialect=eng.dialect)
                default = ""
                arg = getattr(col.default, "arg", None)
                if col.default is not None and not callable(arg) and arg is not None:
                    literal = sa.literal(arg, type_=col.type).compile(
                        dialect=eng.dialect, compile_kwargs={"literal_binds": True}
                    )
                    default = f" DEFAULT {literal}"
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}{default}'))


def get_session():
    with Session(engine) as session:
        yield session

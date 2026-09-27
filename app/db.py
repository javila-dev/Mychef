import os
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine

DB_PATH = os.environ.get("MYCHEF_DB", str(Path(__file__).resolve().parent.parent / "data" / "mychef.db"))

Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def init_db(eng=engine) -> None:
    from . import models  # noqa: F401  (registra las tablas)

    SQLModel.metadata.create_all(eng)


def get_session():
    with Session(engine) as session:
        yield session

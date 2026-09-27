import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session, init_db, normalize_url
from app.main import app

# Para correr las pruebas contra PostgreSQL: MYCHEF_TEST_DATABASE_URL=postgresql://…/mychef_test
TEST_PG = os.environ.get("MYCHEF_TEST_DATABASE_URL")


@pytest.fixture
def client():
    if TEST_PG:
        engine = create_engine(normalize_url(TEST_PG))
        SQLModel.metadata.drop_all(engine)
    else:
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
    init_db(engine)

    def override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    engine.dispose()

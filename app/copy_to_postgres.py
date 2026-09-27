"""Copia todo lo de la base SQLite (data/mychef.db) a PostgreSQL.

    MYCHEF_DATABASE_URL=postgresql://usuario:clave@servidor/mychef python -m app.copy_to_postgres [ruta.db]

La base de PostgreSQL debe estar vacía (recién creada). Las fotos de la familia son archivos:
cópienlas aparte (carpeta data/photos o MYCHEF_PHOTOS).
"""

import sys

from sqlalchemy import func, select, text
from sqlmodel import SQLModel, create_engine

from . import db


def main() -> None:
    if not db.DATABASE_URL:
        sys.exit("Falta MYCHEF_DATABASE_URL con la dirección de PostgreSQL.")
    source_path = sys.argv[1] if len(sys.argv) > 1 else db.DB_PATH
    source = create_engine(f"sqlite:///{source_path}")
    target = db.engine
    db.init_db(source)  # por si el archivo es de una versión anterior
    db.init_db(target)

    tables = SQLModel.metadata.sorted_tables  # en orden de dependencias
    with target.connect() as conn:
        busy = [t.name for t in tables if conn.execute(select(func.count()).select_from(t)).scalar()]
    if busy:
        sys.exit(f"La base de PostgreSQL ya tiene datos ({', '.join(busy)}). Usen una base vacía.")

    with source.connect() as src, target.begin() as dst:
        for table in tables:
            rows = [dict(r._mapping) for r in src.execute(select(table))]
            if rows:
                dst.execute(table.insert(), rows)
            # Que los próximos ids sigan después de los copiados
            if "id" in table.c and rows:
                dst.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('\"{table.name}\"', 'id'), "
                    f"(SELECT MAX(id) FROM \"{table.name}\"))"
                ))
            print(f"{table.name}: {len(rows)}")
    print("Listo. Ahora arranquen la app con MYCHEF_DATABASE_URL.")


if __name__ == "__main__":
    main()

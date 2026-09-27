"""La hora de la casa. El servidor puede estar en UTC (Docker, la nube): las tareas y el menú
tienen que saber qué día es donde vive la familia."""

import datetime as dt
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TZ_NAME = os.environ.get("MYCHEF_TZ", "America/Bogota")
try:
    TZ: dt.tzinfo | None = ZoneInfo(TZ_NAME)
except (ZoneInfoNotFoundError, ValueError):
    TZ = None  # zona desconocida: la del sistema


def now() -> dt.datetime:
    return dt.datetime.now(TZ)


def today() -> dt.date:
    return now().date()

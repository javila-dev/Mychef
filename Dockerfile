FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Sin permisos de administrador: la app solo escribe en /data
RUN useradd --create-home --uid 1000 mychef \
    && mkdir -p /data/photos && chown -R mychef:mychef /data
COPY --chown=mychef:mychef app ./app
COPY --chown=mychef:mychef static ./static
USER mychef

# Todo lo que hay que guardar (base SQLite, fotos, google.json) queda en /data
ENV MYCHEF_DB=/data/mychef.db \
    MYCHEF_PHOTOS=/data/photos
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/auth', timeout=4)" || exit 1

# Detrás del proxy de Dokploy (Traefik): confiar en X-Forwarded-* solo si viene de la red interna.
# Con "*" cualquiera podría inventarse la IP y saltarse el bloqueo tras 8 intentos fallidos.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", \
     "--forwarded-allow-ips", "127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"]

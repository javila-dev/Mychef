"""Dónde se guardan las fotos de la familia: en disco (data/photos) o en MinIO / S3.

Para MinIO:
    MYCHEF_S3_ENDPOINT=https://minio.midominio.com   (o minio:9000 dentro de Docker)
    MYCHEF_S3_ACCESS_KEY=...   MYCHEF_S3_SECRET_KEY=...
    MYCHEF_S3_BUCKET=mychef    (se crea solo si no existe; puede ser privado)

Las fotos siempre se sirven a través de la app (/api/photos/{id}/file), así el bucket no
necesita ser público y el PIN de la casa sigue protegiéndolas.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from urllib.parse import urlparse

from . import db


class StorageError(Exception):
    pass


class LocalStorage:
    kind = "disco"

    def __init__(self, folder: Path | None = None):
        self._folder = folder

    @property
    def folder(self) -> Path:
        return self._folder or db.PHOTOS_DIR  # se lee cada vez: MYCHEF_PHOTOS o el de las pruebas

    def save(self, name: str, data: bytes, content_type: str) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / name).write_bytes(data)

    def read(self, name: str) -> bytes | None:
        path = self.folder / name
        return path.read_bytes() if path.is_file() else None

    def delete(self, name: str) -> None:
        (self.folder / name).unlink(missing_ok=True)

    def names(self) -> list[str]:
        return sorted(p.name for p in self.folder.iterdir()) if self.folder.is_dir() else []


class S3Storage:
    kind = "MinIO"

    def __init__(self, endpoint: str, access_key: str, secret_key: str, bucket: str,
                 secure: bool | None = None, prefix: str = "photos/"):
        from minio import Minio

        parsed = urlparse(endpoint if "://" in endpoint else f"//{endpoint}")
        if secure is None:
            secure = parsed.scheme != "http"
        self.client = Minio(parsed.netloc, access_key=access_key, secret_key=secret_key,
                            secure=secure, region=os.environ.get("MYCHEF_S3_REGION") or None)
        self.bucket = bucket
        self.prefix = prefix
        self._ready = False

    def _ensure_bucket(self) -> None:
        from minio.error import MinioException

        if self._ready:
            return
        try:
            if not self.client.bucket_exists(self.bucket):
                self.client.make_bucket(self.bucket)
        except (MinioException, OSError) as e:
            raise StorageError(f"No se pudo usar el bucket «{self.bucket}» de MinIO: {e}") from e
        self._ready = True

    def save(self, name: str, data: bytes, content_type: str) -> None:
        from minio.error import MinioException

        self._ensure_bucket()
        try:
            self.client.put_object(self.bucket, self.prefix + name, io.BytesIO(data), len(data),
                                   content_type=content_type)
        except (MinioException, OSError) as e:
            raise StorageError(f"No se pudo guardar la foto en MinIO: {e}") from e

    def read(self, name: str) -> bytes | None:
        from minio.error import MinioException, S3Error

        try:
            response = self.client.get_object(self.bucket, self.prefix + name)
        except S3Error as e:
            if e.code in ("NoSuchKey", "NoSuchBucket"):
                return None
            raise StorageError(f"No se pudo leer la foto de MinIO: {e}") from e
        except (MinioException, OSError) as e:
            raise StorageError(f"No se pudo leer la foto de MinIO: {e}") from e
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def delete(self, name: str) -> None:
        from minio.error import MinioException

        try:
            self.client.remove_object(self.bucket, self.prefix + name)
        except (MinioException, OSError) as e:
            raise StorageError(f"No se pudo borrar la foto de MinIO: {e}") from e

    def names(self) -> list[str]:
        self._ensure_bucket()
        return sorted(o.object_name.removeprefix(self.prefix)
                      for o in self.client.list_objects(self.bucket, prefix=self.prefix))


def _from_env():
    endpoint = os.environ.get("MYCHEF_S3_ENDPOINT")
    if not endpoint:
        return LocalStorage()
    secure = os.environ.get("MYCHEF_S3_SECURE")
    return S3Storage(
        endpoint,
        os.environ.get("MYCHEF_S3_ACCESS_KEY", ""),
        os.environ.get("MYCHEF_S3_SECRET_KEY", ""),
        os.environ.get("MYCHEF_S3_BUCKET", "mychef"),
        secure=None if secure is None else secure.lower() in ("1", "true", "si", "sí", "yes"),
    )


_storage = None


def photos():
    """El almacén de fotos configurado (se crea la primera vez que se usa)."""
    global _storage
    if _storage is None:
        _storage = _from_env()
    return _storage


def use(storage) -> None:
    """Para pruebas: reemplaza el almacén."""
    global _storage
    _storage = storage


def upload_local_to_s3() -> None:
    """python -m app.storage: sube a MinIO las fotos que estaban en data/photos."""
    target = photos()
    if not isinstance(target, S3Storage):
        raise SystemExit("Falta MYCHEF_S3_ENDPOINT (y las claves) para saber a qué MinIO subir.")
    local = LocalStorage()
    already = set(target.names())
    count = 0
    for name in local.names():
        if name not in already:
            ext = name.rsplit(".", 1)[-1].lower()
            target.save(name, local.read(name), "image/png" if ext == "png" else "image/jpeg" if ext in ("jpg", "jpeg") else "image/webp")
            count += 1
    print(f"Listo: {count} fotos subidas a MinIO ({len(already)} ya estaban).")


if __name__ == "__main__":
    upload_local_to_s3()

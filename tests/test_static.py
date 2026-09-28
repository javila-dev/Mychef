"""La tablet siempre carga la versión actual del HTML, el CSS y el JS (se revalidan con ETag)."""

import pytest


@pytest.mark.parametrize("path", [
    "/", "/admin", "/manifest.webmanifest",
    "/static/styles.css", "/static/hub.css", "/static/hub.js", "/static/common.js",
    "/static/voice.js", "/static/admin.js",
])
def test_code_is_always_revalidated(client, path):
    res = client.get(path)
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-cache"


def test_unchanged_file_answers_304(client):
    first = client.get("/static/hub.js")
    again = client.get("/static/hub.js", headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    assert again.headers["cache-control"] == "no-cache"


def test_fonts_are_cached_long(client):
    res = client.get("/static/fonts/lexend-latin-400-normal.woff2")
    assert res.status_code == 200
    assert "immutable" in res.headers["cache-control"]

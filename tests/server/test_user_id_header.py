"""X-Ripple-User-Id header 解析"""

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from interfaces.server.deps import get_user_id


def _make_app() -> FastAPI:
    app = FastAPI()

    @app.get("/uid")
    async def r(uid: str = Depends(get_user_id)):
        return {"uid": uid}

    return app


def test_header_present():
    client = TestClient(_make_app())
    r = client.get("/uid", headers={"X-Ripple-User-Id": "alice"})
    assert r.status_code == 200
    assert r.json() == {"uid": "alice"}


def test_header_absent_falls_back_to_default():
    client = TestClient(_make_app())
    r = client.get("/uid")
    assert r.status_code == 200
    assert r.json() == {"uid": "default"}


def test_header_invalid_rejected():
    client = TestClient(_make_app())
    r = client.get("/uid", headers={"X-Ripple-User-Id": "../evil"})
    assert r.status_code == 400


def test_header_whitespace_stripped():
    client = TestClient(_make_app())
    r = client.get("/uid", headers={"X-Ripple-User-Id": "  alice  "})
    assert r.status_code == 200
    assert r.json() == {"uid": "alice"}


def test_header_empty_falls_back_to_default():
    client = TestClient(_make_app())
    r = client.get("/uid", headers={"X-Ripple-User-Id": ""})
    assert r.status_code == 200
    assert r.json() == {"uid": "default"}

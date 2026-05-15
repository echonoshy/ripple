from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router
from interfaces.server.sessions import get_server_tool_names


def _client() -> TestClient:
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    return TestClient(app, headers={"X-Ripple-User-Id": "alice"})


def test_schedule_collection_endpoint_returns_gone():
    response = _client().get("/v1/sandbox/schedules")

    assert response.status_code == 410
    assert "/v1/runs" in response.json()["detail"]


def test_schedule_nested_endpoint_returns_gone():
    response = _client().post("/v1/sandbox/schedules/job-123/run")

    assert response.status_code == 410
    assert "/v1/runs" in response.json()["detail"]


def test_schedule_tool_is_not_model_facing():
    assert "Schedule" not in get_server_tool_names()

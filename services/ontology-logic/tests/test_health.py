"""Health endpoint smoke tests for the ontology-logic REST API."""

from fastapi.testclient import TestClient

from ontology_logic.api.server import app

client = TestClient(app)


def test_healthz_ok() -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "ontology-logic"}


def test_healthz_is_json() -> None:
    resp = client.get("/healthz")
    assert resp.headers["content-type"].startswith("application/json")

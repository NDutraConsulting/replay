def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_unknown_route_uses_the_error_envelope(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_validation_errors_use_the_envelope(client):
    response = client.post("/api/account/signup", json={"username": "x", "password": "short"})
    assert response.status_code == 422
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    assert "username" in body["message"]

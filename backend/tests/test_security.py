"""Cross-origin write protection.

The threat is concrete: this API has no login, so a page the user happens to
have open could otherwise create or rename things on their behalf. CORS is not
a defence — a cross-origin POST still executes; only the response is withheld.
"""

from __future__ import annotations

import pytest

from server.security import allowed_origins, origin_is_allowed


class TestOriginIsAllowed:
    def test_a_request_with_no_origin_is_allowed(self):
        """curl, a server-side caller, a same-origin navigation."""
        assert origin_is_allowed(None, "127.0.0.1:8000")
        assert origin_is_allowed("", "127.0.0.1:8000")

    def test_the_same_host_on_a_different_port_is_allowed(self):
        """The frontend and the API are separate ports in development."""
        assert origin_is_allowed("http://10.99.98.242:3000", "10.99.98.242:8000")
        assert origin_is_allowed("http://localhost:3000", "localhost:8000")

    def test_a_foreign_origin_is_refused(self):
        assert not origin_is_allowed("https://evil.example.com", "10.99.98.242:8000")
        assert not origin_is_allowed("http://10.99.98.243:3000", "10.99.98.242:8000")

    def test_a_forwarded_host_stands_in_for_the_real_host(self):
        """Behind a gateway the Host is ours; X-Forwarded-Host is the browser's."""
        assert origin_is_allowed(
            "https://arsenal.weizhipin.com", "arsenal.weizhipin.com"
        )
        assert not origin_is_allowed(
            "https://evil.example.com", "arsenal.weizhipin.com"
        )

    def test_an_explicitly_allowed_origin_is_accepted_without_a_matching_host(self, monkeypatch):
        monkeypatch.setenv(
            "LLMBENCH_ALLOWED_ORIGINS",
            "https://arsenal.weizhipin.com, https://arsenal-gateway.weizhipin.com",
        )
        assert origin_is_allowed("https://arsenal.weizhipin.com", "127.0.0.1:8000")
        assert origin_is_allowed("https://arsenal-gateway.weizhipin.com", "127.0.0.1:8000")
        assert not origin_is_allowed("https://evil.example.com", "127.0.0.1:8000")

    def test_a_trailing_slash_in_configuration_or_the_header_does_not_matter(self, monkeypatch):
        monkeypatch.setenv("LLMBENCH_ALLOWED_ORIGINS", "https://a.example.com/")
        assert origin_is_allowed("https://a.example.com", "127.0.0.1:8000")
        assert origin_is_allowed("https://a.example.com/", "127.0.0.1:8000")

    def test_an_unparseable_origin_is_refused(self):
        assert not origin_is_allowed("not a url", "127.0.0.1:8000")


class TestAllowedOrigins:
    def test_empty_by_default(self, monkeypatch):
        monkeypatch.delenv("LLMBENCH_ALLOWED_ORIGINS", raising=False)
        assert allowed_origins() == set()

    def test_blank_entries_are_ignored(self, monkeypatch):
        monkeypatch.setenv("LLMBENCH_ALLOWED_ORIGINS", " , https://a.example.com , ")
        assert allowed_origins() == {"https://a.example.com"}


# --- through the app --------------------------------------------------------


def test_a_write_from_a_foreign_origin_is_refused(client):
    response = client.post(
        "/api/models",
        json={"name": "sneaky"},
        headers={"Origin": "https://evil.example.com", "Host": "127.0.0.1:8000"},
    )
    assert response.status_code == 403
    assert client.get("/api/models").json() == []


def test_a_write_from_the_frontend_port_is_allowed(client):
    response = client.post(
        "/api/models",
        json={"name": "legitimate"},
        headers={"Origin": "http://localhost:3000", "Host": "localhost:8000"},
    )
    assert response.status_code == 201


def test_a_read_from_a_foreign_origin_is_not_blocked(client, model_id):
    """Reads are not state-changing, and CORS already withholds the response."""
    response = client.get(
        "/api/models", headers={"Origin": "https://evil.example.com", "Host": "127.0.0.1:8000"}
    )
    assert response.status_code == 200


def test_a_write_from_an_unlisted_gateway_origin_is_refused_then_allowed(client, monkeypatch):
    """The gateway case: the browser's Origin is the gateway, the Host is ours."""
    headers = {"Origin": "https://arsenal.weizhipin.com", "Host": "127.0.0.1:8000"}
    assert client.post("/api/models", json={"name": "one"}, headers=headers).status_code == 403

    monkeypatch.setenv("LLMBENCH_ALLOWED_ORIGINS", "https://arsenal.weizhipin.com")
    assert client.post("/api/models", json={"name": "two"}, headers=headers).status_code == 201


def test_a_forwarded_host_makes_the_gateway_origin_work_without_configuration(client):
    response = client.post(
        "/api/models",
        json={"name": "through-the-gateway"},
        headers={
            "Origin": "https://arsenal.weizhipin.com",
            "Host": "127.0.0.1:8000",
            "X-Forwarded-Host": "arsenal.weizhipin.com",
        },
    )
    assert response.status_code == 201


def test_the_cors_preflight_is_not_treated_as_a_write(client):
    response = client.options(
        "/api/models",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code != 403


@pytest.mark.parametrize("method", ["POST", "PATCH", "DELETE"])
def test_every_unsafe_method_is_covered(client, model_id, method):
    path = "/api/models" if method == "POST" else f"/api/models/{model_id}"
    response = client.request(
        method, path, json={"name": "x"}, headers={"Origin": "https://evil.example.com"}
    )
    assert response.status_code == 403

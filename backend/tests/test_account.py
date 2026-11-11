def test_login_logout_and_me(client):
    assert client.get("/api/me").status_code == 401
    response = client.post("/api/account/login", json={"username": "demo", "password": "demo-password"})
    assert response.status_code == 200
    assert response.json()["username"] == "demo"
    assert "password" not in response.text
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert client.get("/api/me").json()["username"] == "demo"
    assert client.post("/api/account/logout").status_code == 200
    assert client.get("/api/me").status_code == 401


def test_wrong_password_is_rejected_without_leaking_which_part_failed(client):
    wrong_pw = client.post("/api/account/login", json={"username": "demo", "password": "nope"})
    no_user = client.post("/api/account/login", json={"username": "ghost", "password": "nope"})
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json() == no_user.json()
    assert wrong_pw.json()["error"]["code"] == "invalid_credentials"


def test_signup_logs_in_and_rejects_duplicates(client):
    response = client.post("/api/account/signup", json={"username": "Nikko", "password": "long-enough-pw"})
    assert response.status_code == 201
    assert client.get("/api/me").json()["username"] == "Nikko"
    dup = client.post("/api/account/signup", json={"username": "nikko", "password": "long-enough-pw"})
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "username_taken"


def test_password_is_hashed_with_a_cost_prefix(client, db):
    import sqlite3

    stored = sqlite3.connect(db).execute("SELECT password_hash FROM users WHERE username='demo'").fetchone()[0]
    assert stored.startswith("pbkdf2_sha256$1000$")
    assert "demo-password" not in stored


def test_demo_account_seeding_is_idempotent(test_settings, db):
    import asyncio
    import sqlite3

    from services import seed_service

    asyncio.run(seed_service.seed_all(test_settings))
    asyncio.run(seed_service.seed_all(test_settings))
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM users WHERE username='demo'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0] == 3


def test_expired_session_is_rejected(logged_in_client, test_settings, db):
    import sqlite3

    conn = sqlite3.connect(db)
    conn.execute("UPDATE sessions SET created_at = '2000-01-01T00:00:00+00:00'")
    conn.commit()
    response = logged_in_client.get("/api/me")
    assert response.status_code == 401
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_the_demo_account_defaults_to_demo_and_demo():
    from config import Settings

    assert Settings(_env_file=None).DEMO_PASSWORD == "demo"


async def test_the_demo_password_is_set_back_at_startup_without_touching_the_demo_data(test_settings, db):
    import asyncio  # noqa: F401

    from controllers import account_controller
    from repositories import user_repository
    from services import auth_service

    before = await user_repository.get_by_username(test_settings.DATABASE_PATH, "demo")
    await user_repository.set_password_hash(
        test_settings.DATABASE_PATH, before.user_id, auth_service.hash_password("an-old-default", 1000)
    )
    await account_controller.ensure_demo_account(test_settings)
    after = await user_repository.get_by_username(test_settings.DATABASE_PATH, "demo")
    assert after.user_id == before.user_id  # the same account, so its conversations are still its own
    assert auth_service.verify_password(test_settings.DEMO_PASSWORD, after.password_hash)
    assert not auth_service.verify_password("an-old-default", after.password_hash)
    await account_controller.ensure_demo_account(test_settings)  # and a second start changes nothing
    assert (
        await user_repository.get_by_username(test_settings.DATABASE_PATH, "demo")
    ).password_hash == after.password_hash

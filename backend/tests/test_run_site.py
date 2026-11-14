"""./run-site.sh delete (a fresh-install simulation) and stop.

The script is run from a uniquely named COPY in a temp folder (with `backend` linked to the real one). `stop` and `delete` look for
other launchers by the script's own name, so a unique name means a real site you have running is never touched. The databases
are temp files (DATABASE_PATH and friends), and the ports are spare ones."""

import hashlib
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

REPO = Path(__file__).parent.parent.parent
SCRIPT = REPO / "run-site.sh"
REAL_ENV = REPO / "backend" / ".env"

pytestmark = pytest.mark.skipif(not SCRIPT.exists() or not shutil.which("uv"), reason="needs run-site.sh and uv")


@pytest.fixture
def site(tmp_path):
    copy = tmp_path / f"run-site-{uuid.uuid4().hex}.sh"
    shutil.copy(SCRIPT, copy)
    (tmp_path / "backend").symlink_to(REPO / "backend")
    data = tmp_path / "data"
    data.mkdir()
    env = {
        **os.environ,
        "DATABASE_PATH": str(data / "app.db"),
        "KNOWLEDGE_DB_PATH": str(data / "knowledgebase.db"),
        "LOG_DB_PATH": str(data / "Log.db"),
        "BACKEND_PORT": "8791",
        "FRONTEND_PORT": "5791",
    }

    def run(*args):
        return subprocess.run(
            ["bash", str(copy), *args], env=env, capture_output=True, text=True, timeout=120, cwd=tmp_path
        )

    run.data = data
    return run


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def fill(data):
    for name in ("app.db", "app.db-wal", "app.db-shm", "knowledgebase.db", "Log.db", "Log.db-wal"):
        (data / name).write_text("old data")


def test_delete_removes_all_three_databases_and_their_wal_files_and_starts_nothing(site):
    fill(site.data)
    (site.data / "notes.txt").write_text("not a database")
    result = site("delete")
    assert result.returncode == 0, result.stderr
    assert sorted(p.name for p in site.data.iterdir()) == ["notes.txt"]  # only the databases went
    assert "Deleting app.db, knowledgebase.db and Log.db" in result.stdout
    assert "Starting the backend" not in result.stdout and "Starting the frontend" not in result.stdout
    assert "Run ./run-site.sh to start as on a fresh install." in result.stdout


def test_delete_never_creates_changes_or_removes_the_env_file(site):
    before = (REAL_ENV.exists(), fingerprint(REAL_ENV))
    fill(site.data)
    assert site("delete").returncode == 0
    assert site("delete").returncode == 0  # and again, with nothing left to delete
    assert (
        REAL_ENV.exists(),
        fingerprint(REAL_ENV),
    ) == before  # a missing .env stays missing, an existing one is unchanged


def test_delete_with_nothing_to_delete_is_fine(site):
    result = site("delete")
    assert result.returncode == 0, result.stderr
    assert list(site.data.iterdir()) == []


@pytest.mark.parametrize(
    "others", [["stop"], ["restart"], ["reset"], ["--reset"], ["--reset-app"], ["--reset-knowledge"]]
)
def test_delete_cannot_be_combined_with_other_options_and_deletes_nothing(site, others):
    fill(site.data)
    result = site("delete", *others)
    assert result.returncode == 2
    assert "cannot be combined" in result.stderr
    assert (site.data / "app.db").read_text() == "old data"  # nothing was deleted


def test_stop_still_reports_when_nothing_is_running(site):
    result = site("stop")
    assert result.returncode == 0
    assert "Nothing is running on ports 8791 and 5791." in result.stdout

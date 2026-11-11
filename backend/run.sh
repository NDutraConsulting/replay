#!/usr/bin/env bash
# Dev server. The database is persistent: this script NEVER wipes it unless you pass --reset.
#
# Usage: ./run.sh [restart] [--reset | --reset-app | --reset-knowledge | --reset-log]
#   restart            stop whatever is already listening on PORT first
#   --reset            delete app.db, knowledgebase.db AND Log.db before starting (explicit opt-in; all data is lost)
#   --reset-app        delete only app.db (accounts, chats, replays, settings)
#   --reset-knowledge  delete only knowledgebase.db (the knowledge bases)
#   --reset-log        delete only Log.db (the raw API log)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
RESET=
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=all ;;
    --reset-app) RESET=app ;;
    --reset-knowledge) RESET=knowledge ;;
    --reset-log) RESET=log ;;
    restart) RESTART=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "Creating .env with a new ENCRYPTION_KEY..."
  key="$(uv run python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
  { grep -v '^ENCRYPTION_KEY=' .env.example; echo "ENCRYPTION_KEY=$key"; } > .env
fi

if [[ "$RESTART" == 1 ]]; then
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping process(es) on port $PORT: $pids"
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 12); do
      lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 0.25
    done
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN || true)"
    [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  fi
fi

if [[ -n "$RESET" ]]; then
  echo "--reset given: deleting the database file(s): $RESET"
  if [[ "$RESET" == all ]]; then
    uv run python scripts/reset_db.py --yes
  else
    uv run python scripts/reset_db.py --yes --only="$RESET"
  fi
fi

exec uv run uvicorn main:app --reload --port "$PORT"

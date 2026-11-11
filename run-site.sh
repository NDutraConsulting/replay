#!/usr/bin/env bash
# Launch the whole site: the FastAPI backend (backend/run.sh) and the Vite frontend (replay-chat-vite).
# The frontend proxies /api to the backend, so open the frontend URL only.
#
# Usage: ./run-site.sh [stop | restart] [--reset | --reset-app | --reset-knowledge]
#   stop               stop the backend and the frontend (from any terminal) and exit; starts nothing
#   restart            stop whatever is already listening on the backend and frontend ports first, then start
#   --reset*           passed to backend/run.sh. The databases are persistent and are NEVER wiped unless you ask.
# Env:   BACKEND_PORT (default 8000), FRONTEND_PORT (default 5173)
# Stop both with Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")"

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
RESTART=0
STOP=0
BACKEND_ARGS=()
for arg in "$@"; do
  case "$arg" in
    stop) STOP=1 ;;
    restart) RESTART=1 ;;
    --reset | --reset-app | --reset-knowledge) BACKEND_ARGS+=("$arg") ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$STOP" == 1 && ( "$RESTART" == 1 || ${#BACKEND_ARGS[@]} -gt 0 ) ]]; then
  echo "'stop' cannot be combined with other options." >&2
  exit 2
fi

command -v lsof >/dev/null || { echo "Missing required tool: lsof" >&2; exit 1; }
if [[ "$STOP" != 1 ]]; then
  for tool in uv npm curl; do
    command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
  done
fi

listening() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

stop_port() {
  local pids
  pids="$(listening "$1")"
  [[ -z "$pids" ]] && return 0
  echo "Stopping process(es) on port $1: $pids"
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 12); do [[ -z "$(listening "$1")" ]] && return 0; sleep 0.25; done
  kill -9 $(listening "$1") 2>/dev/null || true
}

if [[ "$STOP" == 1 ]]; then
  # the launcher itself (if it runs in another terminal) goes first so it cannot restart anything or print errors
  launchers="$(pgrep -f "$(basename "$0")" | grep -vx "$$" || true)"
  [[ -n "$launchers" ]] && kill -TERM $launchers 2>/dev/null || true
  [[ -n "$launchers" ]] && sleep 1
  if [[ -z "$(listening "$BACKEND_PORT")$(listening "$FRONTEND_PORT")" ]]; then
    echo "Nothing is running on ports $BACKEND_PORT and $FRONTEND_PORT."
  else
    stop_port "$BACKEND_PORT"
    stop_port "$FRONTEND_PORT"
    echo "Stopped."
  fi
  exit 0
fi
if [[ "$RESTART" == 1 ]]; then
  stop_port "$BACKEND_PORT"
  stop_port "$FRONTEND_PORT"
fi
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if [[ -n "$(listening "$port")" ]]; then
    echo "Port $port is already in use. Run './run-site.sh restart' to replace it." >&2
    exit 1
  fi
done

if [[ ! -d replay-chat-vite/node_modules ]]; then
  echo "Installing frontend dependencies..."
  (cd replay-chat-vite && npm install)
fi

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping the site..."
  for pid in "${PIDS[@]}"; do
    # each child leads its own process group (uvicorn --reload and vite start helpers), so stop the whole group
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Starting the backend on http://127.0.0.1:$BACKEND_PORT ..."
set -m
(PORT="$BACKEND_PORT" exec ./backend/run.sh ${BACKEND_ARGS[@]+"${BACKEND_ARGS[@]}"}) &
PIDS+=("$!")

for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1 && break
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then
    echo "The backend stopped before it was ready. See its output above." >&2
    exit 1
  fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1 || { echo "The backend did not become ready in 60 seconds." >&2; exit 1; }
echo "Backend ready."

echo "Starting the frontend on http://localhost:$FRONTEND_PORT ..."
(cd replay-chat-vite && BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" exec npx vite --port "$FRONTEND_PORT" --strictPort) &
PIDS+=("$!")
set +m

echo
echo "Open http://localhost:$FRONTEND_PORT   (demo login: demo / demo, unless DEMO_PASSWORD is set)"
echo "Ctrl-C stops both."
# if either server dies, stop the other too
while kill -0 "${PIDS[0]}" 2>/dev/null && kill -0 "${PIDS[1]}" 2>/dev/null; do sleep 1; done
echo "One of the servers stopped."
exit 1

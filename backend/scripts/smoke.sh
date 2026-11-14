#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING server (nothing is mocked; demo mode, so no LLM account is needed).
#
# Usage: ./scripts/smoke.sh [base_url]        default http://127.0.0.1:8000
# Env:   DEMO_PASSWORD (default demo) must match the server's.
# Point base_url at the Vite dev server (e.g. http://localhost:5173) to test through its /api proxy.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8000}"
PASSWORD="${DEMO_PASSWORD:-demo}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
STATUS=""
BODY=""

call() { # METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}" out
  if [[ -n "$body" ]]; then
    out="$(curl -sS -X "$method" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -d "$body" -w $'\n%{http_code}' "$BASE$path")"
  else
    out="$(curl -sS -X "$method" -b "$JAR" -c "$JAR" -w $'\n%{http_code}' "$BASE$path")"
  fi
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
expect() { # EXPECTED_STATUS DESCRIPTION
  if [[ "$STATUS" != "$1" ]]; then
    echo "FAIL: $2 (expected HTTP $1, got $STATUS): $BODY" >&2
    exit 1
  fi
  echo "ok   $2"
}
field() { # PYTHON_EXPRESSION_ON_d  (d = parsed JSON body)
  printf '%s' "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"
}
check() { # DESCRIPTION PYTHON_EXPRESSION_ON_d
  if [[ "$(field "$2")" != "True" ]]; then
    echo "FAIL: $1: $BODY" >&2
    exit 1
  fi
  echo "ok   $1"
}

SUFFIX="$(date +%s)"

call GET /api/health;                                         expect 200 "health"
call GET /api/me;                                             expect 401 "anonymous request is refused"
call POST /api/account/login "{\"username\":\"demo\",\"password\":\"$PASSWORD\"}"; expect 200 "log in as demo"
call GET /api/me;                                             expect 200 "session cookie works"
call GET /api/agents;                                         expect 200 "agents"
check "three agents, no system prompts" "len(d)==3 and 'system_prompt' not in str(d)"

call PUT /api/settings '{"url":"","models":["m1","m2"]}';    expect 200 "save settings (demo mode)"
call GET /api/preferences;                                    expect 200 "preferences"
check "replay prompts panel starts hidden" "d['replay_prompts_hidden'] is True"

call GET /api/conversations/current;                          expect 200 "current conversation"
check "the sample conversation has a fixed configuration" "d['agent_id'] and d['model'] and d['reasoning_level']=='default' and d['kb_summary_tool'] is False"
call POST /api/conversations '{"name":"Smoke chat","agent_id":"assistant","model":"m1","reasoning_level":"default","kb_summary_tool":false}'
expect 201 "start a conversation with its settings"
CONV="$(field "d['conversation_id']")"
call PATCH "/api/conversations/$CONV" '{"model":"m2"}';        expect 409 "the model cannot be changed afterwards"
call PATCH "/api/conversations/$CONV" '{"name":"Renamed"}';   expect 200 "rename"
call POST "/api/conversations/$CONV/messages" '{"content":"smoke test prompt"}'
expect 200 "send a message"
check "demo reply stored" "d['messages'][1]['demo'] is True and d['messages'][1]['content'].startswith('Demo')"
call POST "/api/conversations/$CONV/stop";                    expect 200 "stop with nothing pending"
check "nothing was stopped" "d['stopped'] is False"
call POST "/api/chat-records" "{\"conversation_id\":\"$CONV\"}"; expect 201 "save a chat record"
call POST "/api/conversations/$CONV/fork" '{}';               expect 201 "fork a conversation (a copy with a new id)"
check "the fork has the prompt and its own id" "d['conversation_id']!='$CONV' and d['messages'][0]['content']=='smoke test prompt' and d['forked_from_conversation_id']=='$CONV'"
call POST "/api/conversations/$CONV/lock";                    expect 200 "lock the source"
call POST "/api/conversations/$CONV/messages" '{"content":"too late"}'; expect 409 "a locked conversation takes no more prompts"
call POST /api/conversations '{"name":"Research chat","agent_id":"research","model":"m1"}'; expect 201 "start a research conversation"
RCONV="$(field "d['conversation_id']")"
call POST "/api/conversations/$RCONV/messages" '{"content":"How should I segment my network and set firewall rules?"}'
expect 200 "ask the research agent (it walks its knowledge base)"
check "the answer carries a three-step decision tree" "[s['step'] for s in d['messages'][1]['decision_trace']]==['category','subcategory','file'] and all(s['outcome']=='chosen' for s in d['messages'][1]['decision_trace'])"
check "the file step names the version it used" "d['messages'][1]['decision_trace'][2]['version_number']>=1"
call POST /api/conversations '{"name":"Summary chat","agent_id":"research","model":"m1","kb_summary_tool":true}'; expect 201 "start a conversation with the KB-summary-tool on"
SCONV="$(field "d['conversation_id']")"
call POST "/api/conversations/$SCONV/messages" '{"content":"How should I segment my network and set firewall rules?"}'
expect 200 "ask with the KB-summary-tool on"
check "a summary stood in for the file" "d['messages'][1]['kb_summary'].startswith('Demo summary of')"
call POST "/api/conversations/$SCONV/compact";                expect 201 "compact starts a new conversation"
check "it starts from a summary and points back" "d['messages'][0]['message_type']=='compacted_summary' and d['source_conversation_id']=='$SCONV'"

call POST /api/replay-runs '{"prompts":["first prompt","second prompt"]}'; expect 201 "create replay run"
RUN="$(field "d['replay_run_id']")"
call POST "/api/replay-runs/$RUN/steps" '{"expected_cursor":0}'; expect 200 "replay step 1"
check "both slots answered" "len(d['results']['a'])==1 and len(d['results']['b'])==1 and d['cursor']==1"
call POST "/api/replay-runs/$RUN/steps" '{"expected_cursor":0}'; expect 409 "stale step is refused"
call POST "/api/replay-runs/$RUN/steps" '{"expected_cursor":1}'; expect 200 "replay step 2"
check "run completed and saved" "d['cursor']==2 and d['saved_at'] is not None"
call GET /api/saved-replays;                                  expect 200 "saved replays"
check "this run is listed for both slots" "[s['slot'] for s in d if s['replay_run_id']=='$RUN']==['a','b']"
call GET "/api/saved-replays/$RUN:a";                         expect 200 "saved replay detail"
call POST /api/replay-runs '{"prompts":["How do I segment my network?"],"agent_id":"research","kb_summary_tool":true}'; expect 201 "create a replay run with the KB-summary-tool on"
RUN2="$(field "d['replay_run_id']")"
call POST "/api/replay-runs/$RUN2/steps" '{"expected_cursor":0}'; expect 200 "replay step with routing"
check "each slot recorded its own decision tree" "all(len(d['results'][s][0]['decision_trace'])==3 for s in 'ab')"
check "each slot saved its own summary" "all(d['results'][s][0]['kb_summary'] for s in 'ab')"

call GET /api/agents/research/knowledge-base;                 expect 200 "research knowledge base"
check "ten security categories" "len(d['categories'])>=10"
call POST /api/agents/research/categories "{\"name\":\"Smoke $SUFFIX\"}"; expect 201 "create category"
CAT="$(field "d['category_id']")"
call POST "/api/categories/$CAT/subcategories" '{"name":"Sub"}';          expect 201 "create sub category"
SUB="$(field "d['subcategory_id']")"
call POST "/api/subcategories/$SUB/documents" '{"title":"notes","content":"hello"}'; expect 201 "create document"
DOC="$(field "d['document_id']")"
check "new files start pending review as notes.txt" "d['status']=='pending-review' and d['title']=='notes.txt'"
call PATCH "/api/documents/$DOC" '{"status":"quarantined"}';  expect 200 "change status"
call DELETE "/api/categories/$CAT";                           expect 204 "delete category (cascades)"
call GET "/api/documents/$DOC";                               expect 404 "document went with it"

call POST /api/account/logout;                                expect 200 "log out"
call GET /api/me;                                             expect 401 "session is gone"
echo "Smoke test passed."

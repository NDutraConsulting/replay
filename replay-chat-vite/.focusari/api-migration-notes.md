# Migration plan: browser storage -> FastAPI routes

Goal: remove every use of `localStorage` / `sessionStorage` from `replay-chat-vite` and replace it with FastAPI routes. This document covers the current state, the target API, the frontend changes, the order of work and the decisions still open. Nothing here is implemented yet.

## 0. Backend as built (2026-11-11)

The backend now exists in `backend/` (see its README), and **the frontend is migrated to it** (2026-11-11): no browser storage is left, every page talks to the API through `src/shared/http.js`, and a login page exists. Where this section differs from sections 3-4 below, **this section wins**. Sections 5-7 describe the plan that was carried out.

**Platform:** SQLite (JSON stored as TEXT), not Postgres. The database persists and evolves through numbered migrations. No audit log.

**Auth (new):** cookie `session_token` (httponly, SameSite=Lax). `POST /api/account/signup|login|logout`, `GET /api/me`. A `demo` account is seeded. Every other route returns 401 `not_logged_in` without the cookie. The frontend needs a login page.

**Errors:** every failure is `{"error": {"code", "message"}}`; show `message` where the old code showed its error text. Codes to handle specially: `stopped` (409, a stop command won: not an error to show), `stale_cursor`, `replay_complete`, `step_in_progress`, `replay_locked`, `conversation_locked` (409, a locked conversation takes no more prompts: fork it with `POST /api/conversations/{id}/fork`), `prompt_in_progress` (409, a prompt is still waiting for its reply, so the conversation cannot be locked or forked yet), `nothing_to_rewind`, `nothing_to_save`, `prompt_removed`, `duplicate_name`, `not_logged_in`/`session_expired`, and the provider errors `llm_unreachable`, `llm_http_error`, `llm_timeout`, `llm_invalid_response`, `llm_empty_response` (502/504).

**Field names are snake_case.** The shapes the UI consumes:

| Resource | Shape |
|---|---|
| Settings (`GET/PUT /api/settings`) | `{url, models[], connected, api_key_set}`. PUT body `{url, models[], api_key?}`: omit `api_key` to keep it, `""` to remove it. `DELETE /api/settings/api-key` ("Use demo") removes the key and keeps the URL. `POST /api/settings/test` returns `{ok, message}` (HTTP 200 even on failure). |
| Preferences | `{agent_id, model, chat_sidebar_hidden, replay_prompts_hidden, show_compact_button, show_rewind_button}`; `replay_prompts_hidden` defaults to **true**, `show_compact_button` to **false** and `show_rewind_button` to **true** (the Chat page's Config popup switches, migration 0018). PUT changes only the fields sent. |
| Conversation | `GET /api/conversations/current` and `POST /api/conversations` -> `{conversation_id, is_sample, messages[]}`; message `{message_id, role, content, status, model, agent, demo, created_at}`. `ignored` messages are never returned. |
| Send | `POST /api/conversations/{id}/messages` body `{content, model, agent_id}` -> `{messages: [user, assistant]}`. The prompt is saved first, so on a provider error or stop the user message stays (`failed` / `stopped`). |
| Rewind | `POST .../rewind` -> `{messages, removed_prompt}`; 409 `nothing_to_rewind` when there is no prompt. |
| Stop | `POST /api/conversations/{id}/stop` and `POST /api/replay-runs/{id}/stop` -> `{stopped: true|false}`. Every send (`POST .../messages`) and step (`POST .../steps`) carries a client-generated `request_id` (8-64 chars of `A-Za-z0-9_-`), and the stop body is `{request_id}`. This makes a stop that reaches the server **before** its request work: the server remembers the id and refuses the request when it arrives. The frontend aborts the fetch as well, after the stop has been sent. User messages in responses carry their `request_id`, so the page can recognise its own prompt after a reload. |
| Chat records | `POST /api/chat-records` body `{conversation_id}` -> `{chat_record_id, name, prompts, created_at}`; `GET` lists oldest first. |
| Replay run | `{replay_run_id, agent_id, prompts[], model_a, model_b, cursor, step_running, saved_at, results: {a: [], b: []}, ...}`. Results are keyed by **slot**, as in the frontend. |
| Create run | `POST /api/replay-runs` body: at most one of `prompts[]`, `conversation_id`, `chat_record_id` (none = the current conversation), plus optional `model_a`, `model_b`, `agent_id`. Creating a run saves the previous one if it has results. 404 from `GET /api/replay-runs/current` means "create one". |
| Step | `POST .../steps` body `{expected_cursor}`. Both slots run concurrently; all-or-nothing. |
| Saved replays | `GET /api/saved-replays` -> summaries `{id: "runId:slot", slot, model, agent_id, completed, prompt_count, response_count, created_at}`; `GET /api/saved-replays/{id}` adds `prompts[]` and `responses[]`. A run is saved when it completes, on `POST .../save`, or when a new run replaces it. A partial run is no longer auto-archived on page load. |
| Knowledge base | `GET /api/agents/{agent_id}/knowledge-base` -> `{agent_id, categories: [{category_id, name, subcategories: [{subcategory_id, name, documents: [{document_id, title, content, status, created_at, updated_at}]}]}]}`. Content is included. Seeded per user on first use; `POST .../knowledge-base/reset` restores the defaults. |
| `decision_trace` | On assistant messages (chat), `results[]` of a replay run and `responses[]` of a saved replay: `null` when the knowledge base was not used, otherwise a list of steps `{step: 'category'|'subcategory'|'file', options: [{id, name}], chosen: {id, name} | null, model, reason, outcome: 'chosen'|'none'|'invalid', at}`. `none` = the agent said nothing is relevant, `invalid` = no usable choice after a retry (the answer then has no reference file). Recorded in `knowledge_base_choice`; each replay slot has its own. Chat messages carry the trace on the answer; the prompt's `request_id` links them. |
| Knowledge base routing | Always on for agents that have `current` files (`KB_ROUTING_ENABLED` switches it off). Up to three extra model calls per answer. Only `current` files are offered to a model, so a file's status controls what an agent can see. The selections already made in the conversation (or replay slot) are shown to the agent as a hint. |
| Upload | `POST /api/subcategories/{id}/documents:upload` as `multipart/form-data` (`files` repeated, `status`) -> `{results: [{filename, ok, document?, error?}]}`; partial success is normal. |

**Done on the frontend (T6.2):** Vite `/api` proxy (`BACKEND_URL`, default `http://localhost:8000`), a login page, every `-api.js` rewritten to call these routes (controllers are async, with load and error states), Stop calls the stop routes with request ids, and the copy no longer mentions browser storage. Verified end to end: `npm run test:live` drives every page against the real backend, and `backend/scripts/smoke.sh` passes through the Vite proxy.

## 1. Current state (what is stored in the browser)

All access goes through `src/shared/storage.js` (`read` / `write`). Every store is synchronous.

| Key | Storage | Written by | Shape | Becomes |
|---|---|---|---|---|
| `replay-messages` | local | chat | `[{role, content, model?, agent?, demo?}]` (seeded with a sample conversation) | conversation + messages |
| `replay-agent`, `replay-model` | local | chat | agent id, model id | user preferences |
| `replay-chat-sidebar-hidden` | local | chat | boolean | user preferences |
| `replay-settings` | local | account | `{url, models[]}` | provider settings |
| `replay-api-key` | **session** | account | string | server-side secret (write-only) |
| `replay-run` | local | replay | `{runId, prompts[], selected:[modelA, modelB], cursor, results:{a:[], b:[]}, agentId}` | replay run |
| `replay-saved-runs` | local | replay | per-slot archive records `{id: runId:slot, runId, model, agentId, prompts, responses, createdAt, completed}` | derived from replay runs |
| `replay-chat-records` | local | replay | `[{id, name, prompts, createdAt}]` | chat records |
| `replay-prompts-hidden` | local | replay | boolean | user preferences |
| `replay-knowledge-bases` | local | agents | `{[agentId]: {categories:[{id,name,subcategories:[{id,name,documents:[{id,title,content,status,createdAt,updatedAt}]}]}]}}` | knowledge base tables |

Other logic that currently runs in the browser and must move or be replaced:

- **LLM calls** (`src/shared/chat-api.js`): the browser calls the provider directly with the user's key (needs CORS on the provider, key lives in the browser).
- **Demo responses** (`src/shared/demo-response.js`) when no key is configured.
- **Agent definitions and system prompts** (`src/shared/agents.js`).
- **Replay engine** (`replay-api.js`): history building, stepping both models, archiving, "partial run saved on next load".
- **Validation and uniqueness rules** for categories, sub categories, documents, uploads (`agents-api.js`, `account-api.js`).
- **Seed data** (sample conversation, default knowledge bases).

Because the app follows `{feature}-controller / -api / -ui`, the change is mostly contained: `-ui.js` files do not change, `-api.js` files become async HTTP clients, controllers `await` them.

## 2. Principles

1. **The server is the source of truth.** No client-side persistence, no client-side archive derivation.
2. **The browser never holds the provider API key.** The backend calls the LLM provider. The key is write-only from the browser's point of view.
3. **One router per feature** in FastAPI, mirroring the frontend features: `chat`, `replay`, `agents`, `account`.
4. **Preserve current behavior** unless listed in "Behavior changes". See section 7 for the list of behaviors to keep.
5. **The backend publishes OpenAPI** (`/openapi.json`); that is the contract. Pydantic models match the shapes below.

## 3. Target API

All routes are under `/api`. JSON in and out. Every resource is scoped to the authenticated user (see decision D1).

### Identity and settings

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/me` | Current user. Used to bootstrap every page. |
| GET | `/api/agents` | `[{id, name}]`. System prompts stay on the server. |
| GET | `/api/settings` | `{url, models[], connected, api_key_set}`. Never returns the key. |
| PUT | `/api/settings` | `{url, models[], api_key?}`. `api_key` omitted = unchanged, `""` = clear. Same validation as `validateConnection`. |
| DELETE | `/api/settings/api-key` | The "Use demo" button. |
| POST | `/api/settings/test` | Sends one short request through the backend. Returns `{ok, message}` (30 s timeout, same messages as today). |
| GET / PUT | `/api/preferences` | `{agent_id, model, chat_sidebar_hidden, replay_prompts_hidden, show_compact_button, show_rewind_button}`. See D4. |

### Chat

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/conversations/current` | `{id, messages[], is_sample}`. Creates the sample conversation on first use. `is_sample` replaces the client-side `isSample()` check. |
| POST | `/api/conversations` | "New chat". Returns an empty conversation. |
| POST | `/api/conversations/{id}/messages` | Body `{content, model, agent_id}`. The server **persists the user message first**, calls the LLM, persists the reply, returns `{messages: [user, assistant]}`. If the LLM fails, the user message stays and the route returns an error (matches "Your prompt is saved"). |
| POST | `/api/conversations/{id}/rewind` | Removes the last user prompt and everything after it. Returns `{messages, removed_prompt}`. |

Message shape: `{id, role, content, model?, agent?, demo?, created_at}`.

Stop button: the client aborts the request. The server should notice the disconnect (`request.is_disconnected()`), cancel the provider call and not store a reply.

### Chat records

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/chat-records` | List. |
| POST | `/api/chat-records` | Body `{conversation_id}`. The server copies the user prompts and names it "Chat record N". Returns 422 when the conversation has no prompts. |

### Replay

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/replay-runs` | Create a run. Body `{prompts[]}` or `{source: {conversation_id} | {chat_record_id}}`, plus `{models: [a, b], agent_id}`. Used by "Load current chat", "Replay" on a record, and "Reset". |
| GET | `/api/replay-runs/current` | The latest run, or 404 when there is none (client then creates one from the current conversation, as `ensureReplay` does today). |
| PATCH | `/api/replay-runs/{id}` | Change `models` / `agent_id`. Only while `cursor == 0`, otherwise 409. |
| POST | `/api/replay-runs/{id}/steps` | Body `{expected_cursor}`. Runs the next prompt for slot A and slot B, persists both results, advances the cursor. 409 if `expected_cursor` is stale or the run is complete. |
| POST | `/api/replay-runs/{id}/save` | The "Save replay" button. |
| GET | `/api/saved-replays` | Summaries: `{id: "{run_id}:{slot}", run_id, slot, model, agent_id, completed, response_count, prompt_count, created_at}`. |
| GET | `/api/saved-replays/{id}` | Full record with `prompts[]` and `responses[]` for the Diff tab. |

Run shape: `{id, prompts[], models: [a, b], agent_id, cursor, results: {a: [], b: []}, created_at}`.
Result entry: `{content, model, demo?, error?, decision_trace?}`. `decision_trace` is reserved for the knowledge base routing described in section 8.

Both models may be the same model; results are keyed by slot, never by model name.

### Agents knowledge base

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/agents/{agent_id}/knowledge-base` | The whole tree (categories > sub categories > documents). Document content may be omitted from this response if it gets large (see "Open questions"). |
| POST | `/api/agents/{agent_id}/categories` | `{name}`. 409 on duplicate name (case-insensitive). |
| DELETE | `/api/categories/{id}` | Cascades to sub categories and documents. |
| POST | `/api/categories/{id}/subcategories` | `{name}`. 409 on duplicate within the category. |
| DELETE | `/api/subcategories/{id}` | Cascades to documents. |
| POST | `/api/subcategories/{id}/documents` | `{title, content?, status?}`. Title normalization (`.txt` suffix) and the 409 duplicate rule move to the server. Default status `pending-review`. |
| POST | `/api/subcategories/{id}/documents:upload` | `multipart/form-data`, one or more files, plus `status`. Server enforces text types and the 200 KB limit. Returns per-file results so partial success is reported like today. |
| GET / PATCH / DELETE | `/api/documents/{id}` | PATCH `{title?, content?, status?}`. Uses `If-Match` / `updated_at` to detect edits from another tab (409). |
| POST | `/api/agents/{agent_id}/knowledge-base/reset` | "Restore defaults": replace with the seed data. |

Status enum (server-validated): `current`, `pending-review`, `malicious-active`, `quarantined`, `archived`. Record who changed a status and when (audit table), because these statuses are security-relevant.

### Error envelope (all routes)

```json
{ "error": { "code": "duplicate_name", "message": "A category named \"Networks\" already exists." } }
```

The frontend shows `message` exactly where it shows validation text today (toast, or the inline modal error). Use 409 for conflicts, 422 for validation, 502/504 for provider failures with the existing user-facing wording ("Could not reach your API...", "API returned HTTP 401...").

## 4. Suggested database model

`users`, `preferences`, `provider_settings` (url, models JSON, `api_key_encrypted`), `conversations`, `messages`, `chat_records` (prompts JSON), `replay_runs` (prompts JSON, models[2], agent_id, cursor, saved_at), `replay_results` (run_id, slot, turn_index, content, model, demo, error, `decision_trace` JSONB), `kb_categories`, `kb_subcategories`, `kb_documents` (status, content, timestamps), `kb_document_status_log`.

A "saved replay" is not a table: it is a (run, slot) with at least one result, exposed by `/api/saved-replays`. This removes the duplicated archive data the browser keeps today.

## 5. Frontend changes

### New

- `src/shared/http.js`: a thin `fetch` wrapper. Base URL from `import.meta.env.VITE_API_BASE_URL` (default `/api`), JSON encode/decode, `AbortSignal` support, credentials per D1, normalizes errors to `{status, code, message}`. Every `-api.js` uses it. Tests mock this one module.
- Vite dev proxy in `vite.config.js`: `/api` -> `http://localhost:8000` so there is no CORS in development.
- A small loading/error pattern for controllers (disable controls while a request is pending; show a toast or inline error on failure). Today nothing is async on load.

### Per file

| File | Change |
|---|---|
| `src/shared/storage.js` | Deleted at the end. |
| `src/shared/settings-store.js` | Becomes an async `loadSettings()` using `GET /api/settings`, cached in memory for the page lifetime. Controllers load it before first render. `getApiKey` / `isConnected` go away; use `connected` from the response. |
| `src/shared/conversation-store.js` | `getMessages/saveMessages/getAgentId/getModel/...` replaced by calls to the conversation and preferences routes. Keep `userPrompts()` (pure helper). Drop `seed`. |
| `src/shared/chat-api.js`, `demo-response.js`, `agents.js` | Deleted. The provider call, demo mode and system prompts are backend responsibilities. Agent id/name come from `GET /api/agents`. |
| `features/chat/chat-api.js` | `loadChatState`, `requestReply`, `rewindMessages`, `isSample` become thin route calls. The reply no longer needs `complete()`. |
| `features/chat/chat-controller.js` | `await` loads and sends; drop the local `messages.push` bookkeeping in favor of the returned messages. Keep the Stop button via `AbortController`. |
| `features/replay/replay-api.js` | All engine logic (`ensureReplay`, `archiveReplay`, `buildHistory`, `runReplayStep`, `resetReplay`, `migrateReplay`, `normalizeDiff` selection helpers stay client-side because they are UI selection) moves to the server. The file keeps only route calls plus `selectDiff` / `normalizeDiff` / `compareWith`. |
| `features/replay/replay-controller.js` | `step()` calls `POST .../steps`; the play-all loop stays in the client. Remove the "archive partial run on load" behavior. |
| `features/agents/agents-api.js` | Model functions (`addCategory`, `updateDocument`, ...) become route calls. Validation errors come from the server. `agents-seed.js` moves to the backend. |
| `features/agents/agents-controller.js` | `commit()` becomes async; `persist()` goes away (every action is its own request). Upload sends `multipart` instead of `FileReader`. |
| `features/account/account-api.js` | `saveConnection`, `disconnect`, `testConnection` map to `PUT /api/settings`, `DELETE .../api-key`, `POST .../test`. The API key input is never pre-filled; show "API key saved" using `api_key_set`. |
| `*-ui.js` | No changes except copy (below) and an "API key saved" state in `account-ui.js`. |

### Copy that becomes wrong and must be updated

- Footer: "Your conversations stay in this browser."
- Chat sidebar: "Saved in your browser".
- Account aside: "Your key stays in this browser tab's session...", "Your browser talks directly to the API you configure. Your key is never sent to Replay Chat's hosting service.", and "Conversations and replay results are saved locally on this device."
- Account page "API URL / key / model IDs" may be removed or reduced depending on D2.

## 6. Order of work

Each phase ends with the app working end to end, with tests passing.

0. **Contract and plumbing.** Resolve D1-D3. Backend scaffolds FastAPI with `/api/me`, `/api/agents`, error envelope, OpenAPI. Frontend adds `http.js`, the dev proxy and the loading/error pattern.
1. **Settings and agents (read).** `GET /api/settings`, `GET /api/agents`, `GET/PUT /api/preferences`. Replace `settings-store.js`, `agents.js` and the preference keys. Smallest surface, unblocks every page.
2. **Knowledge base.** Self-contained, no dependency on chat or replay. Migrate the agents page route by route, including upload and restore defaults. This is also where the backend team's routing work attaches (section 8).
3. **Account.** `PUT /api/settings`, api-key delete, test. After this, the key never touches the browser.
4. **Chat and the LLM proxy.** Conversations, messages, rewind, new chat, chat records. Remove `chat-api.js` (shared) and `demo-response.js` from the frontend.
5. **Replay.** Runs, steps, save, saved replays, diff data. Move the engine to the server. Depends on 1, 3 and 4.
6. **One-time import and cleanup.** See D5. Delete `storage.js`, remove leftover keys, update the copy listed above, update the README.

## 7. Behavior to preserve

- Sending: the user's prompt is saved even if the reply fails or is stopped.
- Stop (chat and replay): abort the request; a stopped replay step does **not** advance the cursor and stores no partial results for that step.
- A replay step is all-or-nothing: results for A and B are stored together, only if both succeed.
- Each slot's history contains the user prompts plus **only its own** earlier successful responses (errored entries are skipped).
- Model A and Model B can be the same model, with separate results.
- Model/agent selection is locked once a replay has started (`cursor > 0`); the server enforces it (409).
- Completing a replay saves it; "Save replay" saves a partial run; "Reset" saves the current run (if it has results) and starts a new one.
- Duplicate names, empty names, unknown status and bad uploads give the same user-facing messages as today.
- All content is rendered escaped (already true in the UI); the server must still treat uploaded text as untrusted.

## 8. Related backend work: knowledge base routing

Documented in the comment block in `src/features/agents/agents-controller.js`. Summary: the agent walks category -> sub category -> file with one LLM call per level, then answers with the file as context. Each step is recorded as `decision_trace` on the replay result and shown in a collapsible section before the final response in the Replay Diff tab. This plan reserves `decision_trace` on result entries and puts the routing behind `POST /api/replay-runs/{id}/steps` and `POST /api/conversations/{id}/messages`.

## 9. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Auth and identity.** Today there is one implicit user per browser. | Cookie session with CSRF protection, same-origin deployment (`/api` behind the same host). Needed before any data is stored. |
| D2 | **Provider configuration.** Who owns the LLM URL, key and model list? | Per-user (or per-org) settings stored server-side with the key encrypted at rest and write-only to the client. If it is admin-managed instead, drop the key/URL fields from the Account page and keep only model choice. |
| D3 | **Where the replay engine runs.** | Server (`POST .../steps`), with A and B called in parallel. The client keeps the play-all loop. |
| D4 | **UI preferences** (sidebar hidden, prompts panel hidden, last agent/model). | Move to `/api/preferences` to meet "no browser storage". If the requirement is relaxed for purely cosmetic state, the two "hidden" flags could stay local. |
| D5 | **Existing browser data.** | If there are real users, add a one-time "Import from this browser" action that posts the legacy keys to `POST /api/import` and clears them after success. If this is still a prototype, skip it and just stop reading the old keys. |
| D6 | **Which file statuses may reach the LLM.** | Only `current`. Never `malicious-active` or `quarantined`. |

## 10. Testing

- Unit tests currently seed `localStorage`. Replace that with a mock of `src/shared/http.js` (or MSW), and `await` controller renders in tests (`vi.waitFor`).
- Keep the existing assertions; they describe the behavior in section 7.
- Backend: pytest with a fake LLM provider for steps, stop/abort, error mapping and the 409 cases above.
- Contract: generate types from `/openapi.json` for the frontend and fail CI when the schema changes without a frontend update.
- Security checks to add: authorization on every resource (user A cannot read user B's runs or documents), upload type/size enforcement, API key never appears in any response or log, rate limiting on message/step routes.

## 11. Open questions

- Should `GET .../knowledge-base` return document content, or only titles and statuses with content fetched via `GET /api/documents/{id}`? (Content can reach 200 KB per file.)
- Is there one conversation per user ("current"), or should the UI eventually list several? The routes above allow either; the current UI only needs "current".
- Pagination for chat records and saved replays, once they grow.
- Retention and deletion: should users be able to delete conversations, runs and records? None of that exists in the UI today.

## 12. Phase 8 as built (2026-11-11): fixed conversation settings, summaries, file versions

API changes the frontend now depends on (all in `../backend/README.md`):

- `POST /api/conversations` takes `{name, agent_id, model, reasoning_level, kb_summary_tool}` (no body is a 422); `GET/PATCH
  /api/conversations/{id}` (PATCH renames only; other fields are 409 `configuration_fixed`); `POST .../compact` starts a new
  conversation from a summary. A conversation view carries its settings, `source_conversation_id`, and messages with
  `message_type` (`chat`, `compacted_summary`), `kb_summary`, `kb_version_deleted`.
- `POST .../messages` carries only `content` and `request_id`; the agent, model and reasoning level come from the conversation.
- Replay: `kb_summary_tool`, `reasoning_level` on create and update (locked after the first step), `context_summary` when the
  replayed conversation began with a summary, `kb_summary` and `kb_version_deleted` on each result, and the setting on each saved
  replay summary.
- Files: `size_bytes`, `version_number` on documents; 422 `kb_document_too_large` (and `error_code` on a rejected upload);
  deleting a file, sub category or category, or restoring defaults, can answer 409 `kb_version_in_use` with
  `error.details = {conversations, replays}`; repeat with `?delete_conversations=true|false`.
- `ApiError.details` carries the error envelope's optional `details`.

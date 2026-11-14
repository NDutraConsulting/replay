# Replay Chat (Vite)

Vite + Vitest rewrite of `../replay-chat`, organized with domain-driven design per page.

## Architecture

Each page is a feature. HTML entry files live at the project root (Vite multi-page requirement); everything else is grouped by feature:

```
index.html | replay.html | agents.html | account.html | login.html     # one HTML5 entry per page
src/features/{feature}/
  {feature}.css                              # page styles
  {feature}-controller.js                    # orchestrates api + ui
  {feature}-api.js                           # requests to the backend, mapped to the shapes the UI reads (no DOM)
  {feature}-ui.js                            # markup + DOM helpers (no requests)
src/shared/                                  # http client, app bootstrap, shell, toast, base.css
src/test/mock-api.js                         # in-memory fake of the backend for unit tests
```

Rule: the controller is the only module that talks to both `-api` and `-ui`.

**The browser stores nothing.** Conversations, replay runs, saved replays, chat records, knowledge bases, settings and
preferences all live on the server (`../backend`); the API key is write-only and never returns. A test
(`src/no-browser-storage.test.js`) fails if `localStorage`, `sessionStorage` or IndexedDB ever come back, or if anything other
than `src/shared/http.js` calls `fetch`.

- `shared/http.js` is the only code that talks to the backend: JSON, the session cookie, and every failure normalized to
  `ApiError { status, code, message }` (`message` is shown to the user). A 401 sends the browser to `/login.html`.
- Every page starts with `startPage()` (`shared/shell-ui.js`): load the user, agents, settings and preferences, mount the shell,
  then run the page; a failed load shows an error with a retry.
- **Stop** (chat and replay) sends a client-generated request id with every send/step. The stop command names it, so it still
  works if it reaches the server first. A stopped chat prompt stays on screen as "Stopped".

## Run

To start both servers at once: `../run-site.sh` (backend on :8000, frontend on :5173; `restart` replaces whatever holds the ports, `stop` stops both from any terminal, `reset` deletes all three databases, rebuilds them, runs the seeders and starts the site for a fresh build, `delete` stops the site and deletes the three databases without starting anything (never touches `backend/.env`), so the next `../run-site.sh` behaves like a first run, Ctrl-C stops both too).

Or by hand: the backend must be running (`cd ../backend && ./run.sh`, http://localhost:8000). Then:

```sh
npm install
npm run dev         # http://localhost:5173; /api is proxied to the backend (BACKEND_URL overrides http://localhost:8000)
```

Open the app and log in (the backend seeds a `demo` account; its password is the backend's `DEMO_PASSWORD`, default
`demo`, so the login is `demo` / `demo`) or sign up. Because `/api` is proxied, the browser sees one origin: the session cookie just works and no CORS
is involved. For a deployment, serve the built files and `/api` from the same host.

## Scripts

`npm run dev` · `npm run build` · `npm test` · `npm run test:watch` · `npm run test:live`

- `npm test`: unit tests against an in-memory fake of the backend (fast, no server needed). The live test is skipped.
- `npm run test:live`: drives every page controller through the DOM against the **real** backend. Start the backend with a
  throwaway database and a demo delay (so the Stop tests have something to stop), then:

  ```sh
  cd ../backend && DATABASE_PATH=/tmp/live.db KNOWLEDGE_DB_PATH=/tmp/live-kb.db DEMO_DELAY_SECONDS=0.4 \
    ENCRYPTION_KEY=$(uv run python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
    uv run uvicorn main:app --port 8770
  cd ../replay-chat-vite && LIVE_API=http://127.0.0.1:8770 npm run test:live
  ```

  It signs up a fresh user, so it can run against any database. It caught a preferences race and two Stop races that the
  unit tests could not see.

## Status

All pages (`chat`, `replay`, `agents`, `account`, `login`) are migrated to the backend and tested. `agents` is new (not in the original
example): a per-agent knowledge base of categories, sub categories and text files with a review status, stored per user on the server. It is
not yet fed into model prompts.

- CSS is split by which source files mention each rule's classes: `base.css` has shared rules, `{feature}.css` has page-only rules.
- Replay results are keyed by slot (A and B), so both slots can use the same model.
- The Diff tab loads the two selected saved replays on demand and shows each response's decision tree (empty until the backend records one).

## Conversation settings, summaries and file versions (built)

- **New conversation popup** (Chat page, "New chat"): name, agent, model, reasoning level and the **KB summary tool**
  (off by default). The agent, model, reasoning level and KB summary tool are **fixed** for the conversation, so conversations can
  be compared against each other; the chat page shows them read-only. The name is only a label: it can repeat and be renamed.
  "Use this chat's settings" fills the popup from the conversation on screen. The reasoning level is OpenAI's `reasoning_effort`
  (or `default`, which leaves it out); a model that rejects it says so when you send.
- **Compact**: a model summarises the conversation (including the files it used) and a new conversation starts from the summary
  with the same settings; the earlier one is unchanged.
- **KB summary tool**: off, the whole knowledge base file is sent; on, a model first writes a summary of it (under 1000 words)
  and that is sent instead. On the Replay page it is **one switch for the whole run** (both slots follow it, and each slot's own
  model writes its summary). It starts from the current chat's setting, can change until the replay starts, and is locked after.
  Each answer shows the summary that stood in for the file; the Diff shows which setting each replay used.
- **Files**: at most 10 KB (saving more shows a "split your content into smaller documents" popup; this tool has no semantic
  search). Every real edit is a new version, and answers show which version they used (`v2`). Deleting a file that
  conversations or replays used asks whether to delete those records too; if they stay they are flagged "Version deleted".
- `shared/modal-ui.js` is the one popup implementation (form popups, choices, notices).

## Knowledge base routing (built)

When an agent answers, the backend first walks that agent's knowledge base: it shows the agent the categories and asks it to
pick one, then the sub categories, then the files, and gives the chosen file to the answer as reference material. Only
`current` files are ever offered, so a file's status on the agents page decides whether an agent can see it. Every level is
recorded and shown as a collapsible **Decision tree** (what the agent was offered, what it chose, which model, why):

- under each chat answer that used the knowledge base,
- on each result of the Replay tab, and
- in the Diff tab, where Replay A and B each have their own tree and differing steps are highlighted.

A level can end in `none` ("Nothing relevant") or `invalid` ("No valid choice"); the answer is then given without a file. The
agent also sees the selections it made earlier in the same conversation (or, in a replay, the same slot). In demo mode, with no
model connected, a keyword match does the choosing so the trees can be seen without an API key. See
`../backend/README.md` for the details and `KB_ROUTING_ENABLED`.


## Guided lessons (built)

`src/features/lessons/`: `lesson-player.js` (plays a lesson from `GET /api/lessons/{slug}`: dim layer with the target left clickable, a ring, a card with the avatar, Back / Next / Skip; Escape skips; it saves progress on every move and a failed save never blocks it), `lesson-ui.js` (layer and card, copy is escaped, only `**bold**` is converted), `lessons-list-ui.js` (File > Lessons popup, and the "Take the tour" button on the Welcome back popup for someone with no completed lesson), `lessons-api.js`. The first lesson, "Start a conversation", is seeded in `backend/db/lesson_seeds/chat_start_conversation.py`. A lesson always starts from its first step. **The ids in the New conversation popup (`#new-chat-name`, `-agent`, `-provider`, `-model`, `-reasoning`, `-temperature`, `-kbsummary`, `-brief`) and `#file-new` are a contract with the lesson**: tests on both sides fail if one is renamed. Avatars: `scripts/make-lesson-avatars.sh` shrinks `.focusari/lesson-avatars/*.png` to small WebP files in `public/lessons/avatars/` (needs `sips` and `cwebp`).

The second lesson, "Replay a chat and compare two models", runs on the Replay page (File > Lessons there). The player looks its target up again by selector whenever the page changes, because the Replay page rebuilds its whole main area on every change; a step with `advance_on` shows a disabled "Waiting…" button until the page shows what it waits for (the Play all popup finishing). The ids it uses (`#file-open`, `.chat-options`, `#replay-agent`, `#model-a`, `#model-b`, `#replay-reasoning`, `#replay-temperature`, `#replay-kb-summary`, `#replay-brief`, `#replay-logprobs`, `#tab-replay`, `#prompts-panel`, `#play-replay`, `#play-all-popup`, `#view-diff-chat`, `#diff-view-api`, `.diff-turn`, `.api-diff-turn`, `#model-diff`) are a contract: a Python test checks them against the source and a Vitest test opens the real File > Open flow.

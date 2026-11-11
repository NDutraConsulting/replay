/**
 * Live test: every page controller, driven through the DOM, against the REAL backend.
 *
 *   cd ../backend && DATABASE_PATH=/tmp/live.db DEMO_DELAY_SECONDS=0.4 ENCRYPTION_KEY=... uv run uvicorn main:app --port 8770
 *   LIVE_API=http://127.0.0.1:8770 npm run test:live
 *
 * Skipped unless LIVE_API is set. It signs up a fresh user, so it can run against any database.
 * The backend needs DEMO_DELAY_SECONDS (about 0.4) so the Stop tests have something to stop.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { api, setUnauthorizedHandler } from './shared/http.js';
import { settle } from './test/mock-api.js';

const BASE = process.env.LIVE_API;
const nodeFetch = globalThis.fetch; // captured before anything replaces it

// ---- a fetch that targets the live server, keeps cookies, and can send jsdom FormData
const jar = new Map();
async function toMultipart(form) {
  const boundary = `----live${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    } else {
      const text = await new Promise((resolve) => Object.assign(new FileReader(), { onload() { resolve(this.result); } }).readAsText(value)); // fmt: skip
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type || 'text/plain'}\r\n\r\n${text}\r\n`);
    }
  }
  return { body: `${parts.join('')}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}
async function liveFetch(url, init = {}) {
  const headers = { ...init.headers };
  let body = init.body;
  if (body instanceof FormData) {
    const multipart = await toMultipart(body);
    body = multipart.body;
    headers['Content-Type'] = multipart.contentType;
  }
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await nodeFetch(new URL(url, BASE), { ...init, headers, body, redirect: 'manual' });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const [name, ...rest] = pair.split('=');
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(cookie) || rest.join('=') === '') jar.delete(name);
    else jar.set(name, rest.join('='));
  }
  return response;
}

const $ = (id) => document.getElementById(id);
const text = (el) => el?.textContent ?? '';
const toastText = () => document.querySelector('.toast')?.textContent;
const eventually = (assertion, timeout = 6000) => vi.waitFor(assertion, { timeout, interval: 25 });
const stepAll = async () => {
  while (!$('step-replay').disabled) {
    $('step-replay').click();
    await eventually(() => expect(text($('run-status'))).not.toMatch(/^Running/), 15000);
  }
};

const unauthorized = vi.fn();

/** Load a page controller fresh. The page gets its own copy of the http module, so the 401 handler goes on that copy. */
async function page(path) {
  vi.resetModules();
  document.body.innerHTML = '';
  (await import('./shared/http.js')).setUnauthorizedHandler(unauthorized);
  await import(/* @vite-ignore */ path);
  // the first load makes several real requests: wait for the page (or its error panel) to appear
  await eventually(() => expect(document.querySelector('#main .page-heading, #main [role="alert"]')).not.toBeNull());
}
const goChat = () => page('./features/chat/chat-controller.js');
const goAccount = () => page('./features/account/account-controller.js');
const goAgents = () => page('./features/agents/agents-controller.js');
/** File > New opens the New conversation popup. */
const openNewPopup = () => {
  $('file-menu-btn').click();
  $('file-new').click();
};
/** File > Config: the replay's settings live in this popup. */
const openConfig = () => {
  $('file-menu-btn').click();
  $('file-config').click();
};
const goReplay = async () => {
  await page('./features/replay/replay-controller.js');
  document.querySelector('.replay-intro-modal button[type="submit"]')?.click(); // the intro popup the page opens with
};

const change = (id, value) => {
  $(id).value = value;
  $(id).dispatchEvent(new Event('change'));
};
const messageCopies = () => [...document.querySelectorAll('.message-copy')].map(text);
const chips = () =>
  Object.fromEntries([...document.querySelectorAll('.chat-toolbar .chip')].map((c) => [text(c.querySelector('b')).toUpperCase(), c.childNodes[1].textContent]));
const modal = () => document.querySelector('.modal');
const field = (name) => modal().querySelector(`[name="${name}"]`);
/** Start a conversation straight through the API (the page then shows it as the current one). */
const newChat = async (config = {}) =>
  api.post('/api/conversations', {
    name: 'Live chat', agent_id: 'assistant', model: (await api.get('/api/settings')).models[0], reasoning_level: 'default', kb_summary_tool: false, ...config,
  }); // fmt: skip

describe.skipIf(!BASE)('live: the frontend against the real backend', () => {
  vi.setConfig({ testTimeout: 30000 });

  beforeAll(async () => {
    globalThis.fetch = liveFetch;
    setUnauthorizedHandler(unauthorized);
    await api.post('/api/account/signup', { username: `live${Date.now()}`, password: 'live-test-password' });
  });

  it('the login page rejects a wrong password with the server message, and skips itself when logged in', async () => {
    vi.resetModules();
    (await import('./shared/http.js')).setUnauthorizedHandler(unauthorized); // (the real login page never redirects to itself)
    const go = vi.fn();
    // logged in already (signed up in beforeAll): the login page sends us on
    const { initLogin } = await import('./features/login/login-controller.js');
    await initLogin({ go });
    expect(go).toHaveBeenCalledWith('/');
    await api.post('/api/account/logout');
    jar.clear();
    go.mockClear();
    await initLogin({ go });
    $('login-username').value = 'demo';
    $('login-password').value = 'definitely-wrong';
    $('login-form').requestSubmit();
    await eventually(() => expect(text($('login-error'))).toBe('Invalid username or password.'));
    expect(go).not.toHaveBeenCalled();
    await api.post('/api/account/signup', { username: `live${Date.now()}b`, password: 'live-test-password' });
  });

  it('an anonymous visit to a page is sent to the login page', async () => {
    const saved = new Map(jar);
    try {
      jar.clear();
      unauthorized.mockClear();
      await goChat();
      expect(unauthorized).toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      saved.forEach((v, k) => jar.set(k, v)); // never leave the session cleared for the tests that follow
    }
  });

  it('chat: shows the sample conversation, sends, rewinds and starts a new chat', async () => {
    await goChat();
    expect(document.querySelectorAll('.message')).toHaveLength(6);
    expect(text(document.querySelector('.drawer-username'))).toMatch(/^live/);

    $('prompt').value = 'Hello from the live test';
    $('chat-form').requestSubmit();
    await eventually(() => expect(messageCopies().at(-1)).toMatch(/^Demo · model-a/));
    expect(messageCopies().at(-2)).toBe('Hello from the live test');
    expect(document.querySelectorAll('.message')).toHaveLength(8);

    $('rewind').click();
    await eventually(() => expect($('prompt').value).toBe('Hello from the live test'));
    expect(document.querySelectorAll('.message')).toHaveLength(6);

    expect(chips()).toMatchObject({ AGENT: 'General assistant', MODEL: 'model-a', 'KB SUMMARY TOOL': 'Off' }); // the sample conversation has its own settings
  });

  it('chat: the New conversation popup fixes name, agent, model, reasoning level and KB summary tool; the sidebar state is remembered', async () => {
    await goChat();
    openNewPopup();
    expect(field('kbsummary').checked).toBe(false);
    field('name').value = 'Live fixed';
    field('agent').value = 'research';
    field('model').value = 'model-c';
    field('reasoning').value = 'high';
    field('kbsummary').checked = true;
    modal().querySelector('form').requestSubmit();
    await eventually(() => expect(text($('conversation-name'))).toBe('Live fixed'));
    expect(modal()).toBeNull();
    $('hide-conversation').click();
    await settle(150);
    await goChat(); // a fresh page load: the server still has the same fixed settings
    expect(text($('conversation-name'))).toBe('Live fixed');
    expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-c', REASONING: 'High', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On' });
    expect($('chat-layout').classList.contains('conversation-hidden')).toBe(true);
    $('show-conversation').click();
    openNewPopup(); // the popup starts from the last agent and model
    expect(field('agent').value).toBe('research');
    expect(field('model').value).toBe('model-c');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle(150);
  });

  it('chat: the settings cannot be changed through the API, but the name can (and may repeat)', async () => {
    const chat = await newChat({ name: 'Same' });
    await expect(api.patch(`/api/conversations/${chat.conversation_id}`, { model: 'model-b' })).rejects.toMatchObject({ status: 409, code: 'configuration_fixed' });
    const renamed = await api.patch(`/api/conversations/${chat.conversation_id}`, { name: 'Renamed' });
    expect(renamed).toMatchObject({ name: 'Renamed', model: chat.model });
    expect((await newChat({ name: 'Renamed' })).name).toBe('Renamed'); // a name is only a label
    await goChat();
    $('rename-chat').click();
    field('name').value = 'Renamed on the page';
    modal().querySelector('form').requestSubmit();
    await eventually(() => expect(text($('conversation-name'))).toBe('Renamed on the page'));
  });

  it('chat: Stop reaches the real server first, so the late reply is ignored', async () => {
    await newChat({ name: 'Stop me' });
    await goChat();
    $('prompt').value = 'stop me';
    $('chat-form').requestSubmit();
    await eventually(() => expect(text($('send'))).toContain('Stop'));
    // like a person, press Stop once the server has the prompt and is working on it
    // (a Stop that beats its prompt to the server is covered by the backend and unit tests)
    await eventually(async () => {
      const { messages } = await api.get('/api/conversations/current');
      expect(messages.at(-1)).toMatchObject({ content: 'stop me', status: 'pending' });
    });
    $('send').click();
    await eventually(() => expect(toastText()).toBe('Response stopped. Your prompt is saved.'));
    await eventually(() => expect(text([...document.querySelectorAll('.message')].at(-1))).toContain('Stopped'));
    await settle(700); // longer than the backend's demo delay: the model's reply arrives now
    const conversation = await api.get('/api/conversations/current');
    const last = conversation.messages.at(-1);
    expect(last).toMatchObject({ role: 'user', content: 'stop me', status: 'stopped' });
    expect(conversation.messages.some((m) => m.status === 'ignored')).toBe(false); // hidden from the client
  });

  it('account: several APIs by label, the server explains an invalid one, the key stays write-only, and deleting the last returns to demo mode', async () => {
    await goAccount();
    expect($('no-apis')).not.toBeNull(); // no API yet: demo mode

    // the server explains what is wrong with an API before it is added
    $('new-api-label').value = 'Live';
    $('new-api-url').value = 'https://api.example.com/v1';
    $('add-api-form').requestSubmit();
    await eventually(() => expect(toastText()).toBe('Add the API key for this API.'));

    $('new-api-key').value = 'sk-live-secret';
    $('add-api-form').requestSubmit();
    await eventually(() => expect(toastText()).toBe('Added the API “Live”.'));
    expect([...$('api-label').options].map(text)).toEqual(['Live']);
    expect($('new-api-key').value).toBe('');

    // models are added under the chosen label, and are then offered as "<label>::<model>"
    $('model-ids').value = 'live-a\nlive-b';
    $('api-form').requestSubmit();
    await eventually(() => expect(toastText()).toBe('Saved “Live”.'));
    const settings = await api.get('/api/settings');
    expect(settings.models).toEqual(['Live::live-a', 'Live::live-b']);
    expect(JSON.stringify(settings)).not.toContain('sk-live-secret'); // the key never comes back
    expect(settings.connections[0]).toMatchObject({ label: 'Live', api_key_set: true, read_only: false });

    // a second API with the same label is refused (case does not matter)
    $('new-api-label').value = 'live';
    $('new-api-url').value = 'https://other.example.com/v1';
    $('new-api-key').value = 'sk-other';
    $('add-api-form').requestSubmit();
    await eventually(() => expect(toastText()).toBe('You already have an API labelled "live".'));

    // deleting the only API goes back to demo mode and the demo models
    $('delete-api').click();
    await eventually(() => expect(document.querySelector('.modal [data-choice="delete"]')).not.toBeNull());
    document.querySelector('.modal [data-choice="delete"]').click();
    await eventually(() => expect($('no-apis')).not.toBeNull());
    expect((await api.get('/api/settings')).models).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('knowledge base: seeded for the user; create, edit, upload, delete and restore through the UI', async () => {
    await goAgents();
    const names = () => [...document.querySelectorAll('.kb-cat > summary .kb-name')].map(text);
    expect(names()).toHaveLength(10);
    expect(names()[0]).toBe('Networks');

    $('open-add-category').click();
    $('new-category').value = 'networks'; // duplicate, case-insensitive
    $('modal-form').requestSubmit();
    await eventually(() => expect(text($('modal-error'))).toBe('A category named "networks" already exists.'));
    $('new-category').value = 'Live category';
    $('modal-form').requestSubmit();
    await eventually(() => expect(names().at(-1)).toBe('Live category'));

    $('open-add-sub').click();
    $('sub-parent').value = document.querySelector('.kb-cat:last-of-type').dataset.node;
    $('new-sub').value = 'Live sub';
    $('modal-form').requestSubmit();
    await eventually(() => expect($('kb-modal')).toBeNull());
    $('doc-parent').value = document.querySelector('.kb-cat:last-of-type .kb-sub').dataset.node;
    $('new-doc').value = 'live-notes';
    $('add-doc-form').requestSubmit();
    await eventually(() => expect($('doc-title')?.value).toBe('live-notes.txt'));
    expect($('doc-status').value).toBe('pending-review');

    $('doc-content').value = 'Written through the live UI.';
    $('doc-status').value = 'quarantined';
    $('doc-form').requestSubmit();
    await eventually(() => expect(toastText()).toBe('File saved.'));
    expect(document.querySelector('.kb-flag')).not.toBeNull();

    const input = $('upload-docs');
    Object.defineProperty(input, 'files', { value: [new File(['uploaded body'], 'uploaded.txt', { type: 'text/plain' }), new File(['x'], 'bad.png', { type: 'image/png' })], configurable: true });
    $('new-doc-status').value = 'current';
    input.dispatchEvent(new Event('change'));
    await eventually(() => expect($('doc-content')?.value).toBe('uploaded body'));
    expect(toastText()).toBe('"bad.png" is not a text file.');

    vi.stubGlobal('confirm', vi.fn(() => true));
    document.querySelector('.kb-cat:last-of-type [data-delete-category]').click();
    await eventually(() => expect(names()).not.toContain('Live category'));

    $('reset-kb').click();
    await eventually(() => expect(toastText()).toBe('Defaults restored.'));
    expect(names()).toHaveLength(10);

    $('agent-select').value = 'code';
    $('agent-select').dispatchEvent(new Event('change'));
    await eventually(() => expect(names()).toEqual(['Python', 'C++']));
  });

  it('knowledge base routing: the research agent walks its knowledge base, in chat and in a replay', async () => {
    const stepNames = (root) => [...root.querySelectorAll('.decision-step b')].map(text);
    await newChat({ name: 'Routing', agent_id: 'research' }); // a clean conversation for this test

    // chat: the answer carries the recorded walk (demo mode picks by keyword, so no API key is needed)
    await goChat();
    $('prompt').value = 'How should I segment my network and set firewall rules?';
    $('chat-form').requestSubmit();
    await eventually(() => expect(document.querySelector('.message:last-of-type .decision-tree')).not.toBeNull());
    let answer = document.querySelector('.message:last-of-type');
    expect(text(answer.querySelector('.decision-tree summary'))).toContain('3 steps');
    expect(stepNames(answer)).toEqual(['Networks', 'Segmentation & Firewalls', 'network-segmentation.txt']);
    expect(text(answer.querySelector('.message-copy'))).toMatch(/Knowledge base: Networks \/ Segmentation & Firewalls \/ network-segmentation\.txt$/);

    // a follow-up goes to a different area; both walks are kept and shown again after a reload
    $('prompt').value = 'And what about monitoring and logging?';
    $('chat-form').requestSubmit();
    await eventually(() => expect(document.querySelectorAll('.message .decision-tree')).toHaveLength(2));
    await goChat();
    const trees = [...document.querySelectorAll('.message')].map((m) => stepNames(m)).filter((names) => names.length);
    expect(trees).toHaveLength(2);
    expect(trees[0][0]).toBe('Networks');
    expect(trees[1][0]).toBe('Security Monitoring');

    // replay: each slot records its own walk; shown on the Replay tab and in the Diff
    await goReplay();
    $('load-prompts').click();
    await eventually(() => expect(toastText()).toMatch(/Loaded 2 prompts/));
    openConfig();
    change('replay-agent', 'research');
    await eventually(() => expect($('replay-agent').value).toBe('research'));
    await stepAll(); // Step through is what shows the Model responses panel
    await eventually(() => expect(text($('run-status'))).toBe('Replay complete'), 15000);
    expect(stepNames(document.querySelector('.result-entry'))[0]).toBe('Networks'); // the Replay tab shows slot A's walk

    $('tab-diff').click();
    await eventually(() => expect(document.querySelectorAll('.diff-turn')).toHaveLength(2));
    expect(document.querySelectorAll('.decision-tree')).toHaveLength(2); // one per turn, A and B side by side
    expect(document.body.textContent).not.toContain('none recorded');
    const firstTurn = document.querySelector('.diff-turn');
    const tree = firstTurn.querySelector('.decision-tree');
    expect(text(tree.querySelector('summary'))).toContain('A · 3 steps');
    expect(text(tree.querySelector('summary'))).toContain('B · 3 steps');
    for (const side of ['a', 'b']) expect(text(tree.querySelector(`.diff-row:not(.diff-head) .diff-cell.${side}`))).toBe('Step 1 · Category');
  });

  it('replay: play all, saved replays, chat records, diff with decision-tree slots, and Stop playback', async () => {
    // two prompts in a fresh conversation
    const conversation = await newChat({ name: 'Replay source', model: 'model-a' });
    for (const content of ['first live prompt', 'second live prompt']) {
      await api.post(`/api/conversations/${conversation.conversation_id}/messages`, { content });
    }

    await goReplay();
    // start a fresh run from this conversation (the page may hold a finished run from an earlier test)
    $('load-prompts').click();
    await eventually(() => expect(toastText()).toMatch(/Loaded 2 prompts/));
    expect(document.querySelectorAll('.prompt-row')).toHaveLength(2);
    openConfig();
    expect($('replay-agent').value).toBe('assistant');
    expect($('model-a').value).toBe('model-a');
    expect($('model-b').value).toBe('model-b');
    expect($('replay-layout').classList.contains('prompts-hidden')).toBe(true); // closed by default, from the server

    await stepAll(); // Step through is what shows the Model responses panel
    await eventually(() => expect(text($('run-status'))).toBe('Replay complete'));
    expect([...document.querySelectorAll('.result-tabs button')].map(text)).toEqual(['A · model-a', 'B · model-b']);
    expect(text(document.querySelector('.result-entry'))).toContain('Demo · model-a');

    $('tab-history').click();
    expect(document.querySelectorAll('.version-head')).not.toHaveLength(0); // the finished run is a saved version of this chat
    expect(document.querySelector('[data-compare-record]')).not.toBeNull();

    $('tab-diff').click();
    await eventually(() => expect(document.querySelectorAll('.diff-turn')).toHaveLength(2));
    expect(document.querySelectorAll('.decision-tree')).toHaveLength(2); // one per turn, A and B side by side
    expect(text(document.querySelector('.decision-tree summary'))).toContain('none recorded');
    expect($('diff-a').value).not.toBe($('diff-b').value);

    // replay the chat again as a new run, then stop it mid-step
    $('tab-replay').click();
    $('reset-replay').click();
    await eventually(() => expect($('tab-replay').getAttribute('aria-selected')).toBe('true'));
    expect(text(document.querySelector('.progress-row'))).toContain('0 / 2 prompts');
    $('play-replay').click();
    await eventually(() => expect(text($('play-replay'))).toContain('Stop playback'));
    expect(text(document.querySelector('.play-overlay h2'))).toMatch(/^Replay v\d+ is running$/);
    $('stop-play').click();
    await eventually(() => expect(toastText()).toBe('Playback stopped. Resume from this prompt.'));
    await settle(700);
    const run = await api.get('/api/replay-runs/current');
    expect(run.step_running).toBe(false);
    expect(run.cursor).toBe(0); // the stopped step stored nothing
    expect(run.results).toEqual({ a: [], b: [] });
    expect(text($('step-replay'))).toContain('Step through');
    expect($('step-replay').disabled).toBe(false);

    // the run can be stepped again; changing the config then resets it and the partial run is kept as a saved replay
    $('step-replay').click();
    await eventually(() => expect(text(document.querySelector('.progress-row'))).toContain('1 / 2 prompts'));
    expect($('save-replay')).toBeNull(); // the Save button became Config
    $('open-config').click();
    $('replay-temperature').value = '0.5';
    $('replay-temperature').dispatchEvent(new Event('change'));
    await eventually(() => expect(toastText()).toBe('Config changed, so the replay was reset. The results so far are saved. Start a new run.'));
    await eventually(() => expect(text(document.querySelector('.progress-row'))).toContain('0 / 2 prompts'));
  });

  it('chat: with the KB summary tool on a summary is sent instead of the file, and Compact starts a new conversation from a summary', async () => {
    await newChat({ name: 'Summary chat', agent_id: 'research', kb_summary_tool: true, reasoning_level: 'low' });
    await goChat();
    $('prompt').value = 'How should I segment my network and set firewall rules?';
    $('chat-form').requestSubmit();
    await eventually(() => expect(document.querySelector('.message:last-of-type .kb-summary')).not.toBeNull());
    const answer = document.querySelector('.message:last-of-type');
    expect(text(answer.querySelector('.kb-summary-text'))).toMatch(/^Demo summary of Networks \/ Segmentation & Firewalls \/ network-segmentation\.txt/);
    expect(text(answer.querySelector('.decision-version'))).toBe('v1');

    $('compact-chat').click();
    await eventually(() => expect(text($('conversation-name'))).toBe('Summary chat (summary)'));
    expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-a', REASONING: 'Low', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On' }); // the settings carry over
    expect(document.querySelectorAll('.message')).toHaveLength(1);
    expect(text(document.querySelector('.message'))).toContain('Summary of an earlier conversation');
    const current = await api.get('/api/conversations/current');
    expect(current.messages[0]).toMatchObject({ message_type: 'compacted_summary', role: 'assistant' });
    expect(current.source_conversation_id).toBeTruthy();
    const earlier = await api.get(`/api/conversations/${current.source_conversation_id}`);
    expect(earlier.messages).toHaveLength(2); // the earlier conversation is untouched

    $('prompt').value = 'continue from the summary';
    $('chat-form').requestSubmit();
    await eventually(() => expect(document.querySelectorAll('.message')).toHaveLength(3));
  });

  it('knowledge base: a file over 10 KB gets the "split your content" popup; deleting a file that records used asks first and flags them', async () => {
    await goAgents();
    document.querySelector('[data-doc]').click();
    $('doc-content').value = 'x'.repeat(10 * 1024 + 1);
    $('doc-form').requestSubmit();
    await eventually(() => expect(text(modal())).toContain('You need to split your content into smaller documents.'));
    expect(text(modal())).toContain('This tool does not currently support semantic search.');
    document.querySelector('[data-choice="ok"]').click();
    await eventually(() => expect(modal()).toBeNull());

    // the file the summary chat used (network-segmentation.txt) now has a conversation behind it
    const doc = [...document.querySelectorAll('[data-doc]')].find((b) => text(b).includes('network-segmentation.txt'));
    doc.click();
    expect($('doc-size').textContent).toMatch(/version 1/);
    $('delete-doc').click();
    await eventually(() => expect(text(modal())).toMatch(/conversations? and \d+ replays? were answered with it/));
    document.querySelector('[data-choice="keep"]').click();
    await eventually(() => expect(toastText()).toBe('File deleted.'));

    await goChat();
    // the conversation that used the file is still there, flagged
    const flagged = await api.get('/api/conversations/current');
    expect(flagged.source_conversation_id).toBeTruthy();
    const source = await api.get(`/api/conversations/${flagged.source_conversation_id}`);
    expect(source.messages.at(-1).kb_version_deleted).toBe(true);
    expect(source.messages.at(-1).decision_trace[2]).toMatchObject({ kb_version_deleted: true, chosen: { name: 'network-segmentation.txt' } });
    await api.post('/api/agents/research/knowledge-base/reset?delete_conversations=false'); // put the defaults back
  });

  it('replay: one KB summary switch for the run; each slot saves the summary its model wrote, shown in the results and the Diff', async () => {
    const chat = await newChat({ name: 'Replay summaries', agent_id: 'research', kb_summary_tool: true, reasoning_level: 'medium', model: 'model-a' });
    await api.post(`/api/conversations/${chat.conversation_id}/messages`, { content: 'How should I segment my network?' });
    await goReplay();
    $('load-prompts').click();
    await eventually(() => expect(toastText()).toMatch(/Loaded 1 prompts/));
    openConfig();
    expect(document.querySelector('.source-chat').textContent).toContain('Replay summaries');
    expect($('replay-kb-summary').checked).toBe(true); // it starts from the chat's setting
    expect($('replay-reasoning').value).toBe('medium');
    // a checkbox: switch it off, then on again, before anything is run
    $('replay-kb-summary').checked = false;
    $('replay-kb-summary').dispatchEvent(new Event('change'));
    await eventually(async () => expect((await api.get('/api/replay-runs/current')).kb_summary_tool).toBe(false));
    $('replay-kb-summary').checked = true;
    $('replay-kb-summary').dispatchEvent(new Event('change'));
    await eventually(async () => expect((await api.get('/api/replay-runs/current')).kb_summary_tool).toBe(true));

    await stepAll(); // Step through is what shows the Model responses panel
    await eventually(() => expect(text($('run-status'))).toBe('Replay complete'), 15000);
    expect($('replay-kb-summary').disabled).toBe(true); // locked once the run started
    expect(text(document.querySelector('.result-entry .kb-summary-text'))).toMatch(/^Demo summary of /);
    document.querySelector('[data-result="b"]').click();
    expect(text(document.querySelector('.result-entry .kb-summary-text'))).toMatch(/^Demo summary of /);

    $('tab-history').click();
    expect(document.body.textContent).toContain('Reasoning Medium');
    expect(document.body.textContent).toContain('KB summary tool on');
  });
});

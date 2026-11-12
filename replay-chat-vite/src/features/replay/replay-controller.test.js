import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '../../shared/http.js';
import { closeModal } from '../../shared/modal-ui.js';
import { apiError, appRoutes, created, mockApi, settle } from '../../test/mock-api.js';

const $ = (id) => document.getElementById(id);
const ID = /^[A-Za-z0-9_-]{8,64}$/; // a request id the backend accepts
const text = (el) => el?.textContent ?? '';
/** File > Config: the replay's settings live in this popup. */
const openConfig = () => {
  $('file-menu-btn').click();
  $('file-config').click();
};
const toastText = () => document.querySelector('.toast')?.textContent;

const chatMessages = (...prompts) =>
  prompts.flatMap((content, i) => [
    { message_id: `u${i}`, role: 'user', content, status: 'complete' },
    { message_id: `a${i}`, role: 'assistant', content: `answer ${i}`, status: 'complete' },
  ]);

/**
 * An in-memory fake of the replay routes. A run is { id, agent_id, prompts, model_a, model_b, cursor, saved_at, results }.
 * `server.hold` makes a step wait until `server.release()` (or until its request is aborted).
 */
function replayServer({
  run = null,
  prompts = ['first prompt', 'second prompt', 'third prompt'],
  otherChats = [],
  appOverrides = {},
  stepFailure = null,
  savedRuns = [],
  chatConfig = {},
} = {}) {
  const { state: app, routes } = appRoutes(appOverrides);
  const chat = { name: 'Sample conversation', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', kb_summary_tool: false, ...chatConfig };
  const server = { chat, app, runs: [...savedRuns, ...(run ? [run] : [])], otherChats, order: [], hold: false, release: () => {}, stepFailure, running: false, prompts };
  let n = 1;
  const current = () => server.runs.at(-1);
  const view = (r) => ({
    replay_run_id: r.id, agent_id: r.agent_id, prompts: r.prompts, model_a: r.model_a, model_b: r.model_b, cursor: r.cursor,
    kb_summary_tool: r.kb_summary_tool ?? false, reasoning_level: r.reasoning_level ?? 'default', temperature: r.temperature ?? 0, logprobs: r.logprobs ?? false, brief_replies: r.brief_replies ?? false, context_summary: r.context_summary ?? null, source_conversation_id: r.source_conversation_id ?? null,
    step_running: server.running, saved_at: r.saved_at, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    results: structuredClone(r.results),
  }); // fmt: skip
  const summaries = () =>
    server.runs.filter((r) => r.saved_at).flatMap((r) =>
      ['a', 'b'].filter((slot) => r.results[slot].length).map((slot) => ({
        id: `${r.id}:${slot}`, replay_run_id: r.id, slot, model: slot === 'a' ? r.model_a : r.model_b, agent_id: r.agent_id,
        completed: r.cursor === r.prompts.length, prompt_count: r.prompts.length, response_count: r.results[slot].length, created_at: r.saved_at,
        kb_summary_tool: r.kb_summary_tool ?? false, reasoning_level: r.reasoning_level ?? 'default', temperature: r.temperature ?? 0, logprobs: r.logprobs ?? false, brief_replies: r.brief_replies ?? false, source_conversation_id: r.source_conversation_id ?? null,
      })),
    ); // fmt: skip
  const newRun = (body) => {
    const previous = current();
    if (previous && (previous.results.a.length || previous.results.b.length)) previous.saved_at ??= '2026-02-01T00:00:00Z';
    const other = server.otherChats.find((c) => c.conversation_id === body.conversation_id);
    const list = body.prompts ?? (other ? other.messages.filter((m) => m.role === 'user').map((m) => m.content) : server.prompts);
    const fromChat = !body.prompts; // a run from a conversation starts from its settings
    const source = body.conversation_id ?? body.source_conversation_id ?? (fromChat ? 'c1' : null);
    const r = { id: `run${n++}`, source_conversation_id: source, kb_summary_tool: body.kb_summary_tool ?? (fromChat ? server.chat.kb_summary_tool : false), reasoning_level: body.reasoning_level ?? 'none', temperature: body.temperature ?? (fromChat ? server.chat.temperature ?? 0 : 0), logprobs: body.logprobs ?? false, agent_id: body.agent_id ?? (fromChat ? server.chat.agent_id : app.preferences.agent_id), prompts: list, model_a: body.model_a ?? app.settings.models[0], model_b: body.model_b ?? app.settings.models[1], cursor: 0, saved_at: null, results: { a: [], b: [] } }; // fmt: skip
    server.runs.push(r);
    return r;
  };
  const result = (slot, model, turn, run) => ({ content: `${slot.toUpperCase()}${turn}`, model, demo: true, error: false, decision_trace: null, kb_summary: run?.kb_summary_tool ? `summary by ${model}` : null });

  const mock = mockApi({
    ...routes,
    'GET /api/conversations/current': () => ({ conversation_id: 'c1', is_sample: false, ...server.chat, messages: chatMessages(...prompts) }),
    'GET /api/conversations': () => [
      { conversation_id: 'c1', ...server.chat, prompt_count: prompts.length, updated_at: '2026-01-03T00:00:00Z' },
      ...server.otherChats.map((c) => ({ ...c, messages: undefined })),
    ],
    'GET /api/conversations/:id': ({ params }) => {
      const other = server.otherChats.find((c) => c.conversation_id === params.id);
      return other ? structuredClone(other) : apiError(404, 'not_found', 'Conversation not found.');
    },
    'POST /api/conversations/:id/open': ({ params }) => {
      if (params.id === 'c1') return { conversation_id: 'c1', is_sample: false, ...server.chat, messages: chatMessages(...prompts) };
      const other = server.otherChats.find((c) => c.conversation_id === params.id);
      return other ? structuredClone(other) : apiError(404, 'not_found', 'Conversation not found.');
    },
    'GET /api/saved-replays': () => summaries(),
    'GET /api/saved-replays/:id/logprobs': ({ params }) => {
      if (server.failLogprobs) return server.failLogprobs;
      const [runId, slot] = decodeURIComponent(params.id).split(':');
      const r = server.runs.find((x) => x.id === runId);
      if (!r) return apiError(404, 'not_found', 'Saved replay not found.');
      const tokens = server.logprobTokens?.[slot] ?? null;
      return { id: decodeURIComponent(params.id), available: Boolean(tokens), turns: r.results[slot].map((_, turn) => ({ turn_index: turn, tokens })) };
    },
    'GET /api/saved-replays/:id/api-log': ({ params }) => {
      if (server.failApiLog) return server.failApiLog;
      const [runId, slot] = decodeURIComponent(params.id).split(':');
      const r = server.runs.find((x) => x.id === runId);
      if (!r) return apiError(404, 'not_found', 'Saved replay not found.');
      const mode = server.apiLogMode ?? 'calls'; // calls | demo | unrecorded
      const call = (purpose, turn) => ({
        at: '2026-01-01T00:00:00Z', purpose, method: 'POST', url: 'https://api.openai.com/v1/chat/completions', duration_ms: 100 + turn,
        request: { headers: { Authorization: 'Bearer <redacted>', 'Content-Type': 'application/json' }, body: { model: slot === 'a' ? r.model_a : r.model_b, messages: [{ role: 'user', content: r.prompts[turn] }] } },
        response: { status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}', truncated: false }, error: null,
      }); // fmt: skip
      return {
        id: decodeURIComponent(params.id), recorded: mode !== 'unrecorded', model: slot === 'a' ? r.model_a : r.model_b,
        turns: r.results[slot].map((_, turn) => ({ turn_index: turn, prompt: r.prompts[turn], calls: mode === 'calls' ? [call('kb_route:category', turn), call('answer', turn)] : [] })),
      }; // fmt: skip
    },
    'GET /api/saved-replays/:id': ({ params }) => {
      server.order.push('detail');
      const [runId, slot] = params.id.split(':');
      const r = server.runs.find((x) => x.id === runId);
      const s = summaries().find((x) => x.id === params.id);
      return { ...s, prompts: r.prompts, responses: r.results[slot] };
    },
    'GET /api/replay-runs/current': () => {
      server.order.push('sync');
      return current() ? view(current()) : apiError(404, 'not_found', 'Replay run not found.');
    },
    'POST /api/replay-runs': ({ body }) => (server.failCreate ? server.failCreate : created(view(newRun(body)))),
    'PATCH /api/replay-runs/:id': async ({ body }) => {
      server.order.push('patch');
      if (server.holdPatch) await new Promise((resolve) => (server.releasePatch = resolve));
      const r = current();
      if (r.cursor > 0) return apiError(409, 'replay_locked', 'Models and agent are locked once a replay has started. Reset to change them.');
      Object.assign(r, body);
      return view(r);
    },
    'POST /api/replay-runs/:id/steps': async ({ body, signal }) => {
      server.order.push('step');
      const r = current();
      if (body.expected_cursor !== r.cursor) return apiError(409, 'stale_cursor', 'This replay has moved on. Reload it and try again.');
      if (server.stepFailure) return server.stepFailure;
      if (server.hold) {
        server.running = true;
        await new Promise((resolve) => {
          server.release = resolve;
          signal?.addEventListener('abort', resolve);
        });
        const stopped = server.running === 'stopped' || signal?.aborted;
        server.running = false;
        if (stopped) throw new DOMException('Aborted', 'AbortError');
      }
      r.results.a.push(result('a', r.model_a, r.cursor, r));
      r.results.b.push(result('b', r.model_b, r.cursor, r));
      r.cursor += 1;
      if (r.cursor === r.prompts.length) r.saved_at ??= '2026-03-01T00:00:00Z';
      return view(r);
    },
    'POST /api/replay-runs/:id/stop': () => {
      server.order.push('stop');
      const was = Boolean(server.running);
      if (was) server.running = 'stopped';
      return { stopped: was };
    },
    'POST /api/replay-runs/:id/save': () => {
      const r = current();
      if (!r.results.a.length) return apiError(409, 'nothing_to_save', 'Run at least one prompt before saving.');
      r.saved_at ??= '2026-04-01T00:00:00Z';
      return view(r);
    },
  });
  return { server, mock };
}

const existingRun = (extra = {}) => ({
  id: 'run0', agent_id: 'assistant', prompts: ['first prompt', 'second prompt', 'third prompt'], model_a: 'model-a', model_b: 'model-b',
  cursor: 0, saved_at: null, source_conversation_id: 'c1', results: { a: [], b: [] }, ...extra,
}); // fmt: skip

/** A run whose prompts have all been sent: the only state in which the Reset button is shown. */
const finishedRun = (extra = {}) => {
  const answers = (slot, model) => ['first prompt', 'second prompt', 'third prompt'].map((_, i) => ({ content: `${slot.toUpperCase()}${i}`, model, demo: true, error: false }));
  return existingRun({ cursor: 3, saved_at: '2026-03-01T00:00:00Z', results: { a: answers('a', 'model-a'), b: answers('b', 'model-b') }, ...extra });
};

/** Load the page. The intro popup it opens with is dismissed so each test starts clean (`keepIntro: true` leaves it). */
async function boot({ keepIntro = false, ...options } = {}) {
  vi.resetModules();
  document.body.innerHTML = '';
  setUnauthorizedHandler(vi.fn());
  const fake = replayServer(options);
  await import('./replay-controller.js');
  await settle();
  if (!keepIntro) {
    document.querySelector('.replay-intro-modal button[type="submit"]')?.click();
    await settle();
  }
  return fake;
}
const click = async (id) => {
  $(id).click();
  await settle();
};
const openTab = async (id) => {
  $(`tab-${id}`).click();
  await settle();
};
const progress = () => text(document.querySelector('.progress-row'));

describe('replay page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('starting up', () => {
    it('shows the current run from the server', async () => {
      await boot({ run: existingRun({ cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] } }) });
      expect(document.querySelectorAll('.prompt-row')).toHaveLength(3);
      openConfig();
      expect($('model-a').value).toBe('model-a');
      expect($('model-b').value).toBe('model-b');
      expect(progress()).toContain('1 / 3 prompts');
      expect(document.querySelector('.results')).toBeNull(); // Model responses wait for Step through
      await click('step-replay');
      expect([...document.querySelectorAll('.result-tabs button')].map(text)).toEqual(['A · model-a', 'B · model-b']);
      expect(text(document.querySelector('.result-entry'))).toContain('A0');
      expect(text(document.querySelector('.drawer-username'))).toBe('demo');
    });

    it('shows the knowledge-base walk of each result on the Replay tab', async () => {
      const trace = [{ step: 'category', options: [{ id: 'c1', name: 'Networks' }, { id: 'c2', name: 'Cloud' }], chosen: { id: 'c1', name: 'Networks' }, model: 'model-a', reason: 'It is about networks', outcome: 'chosen', at: '2026-01-01T00:00:00Z' }, { step: 'subcategory', options: [{ id: 's1', name: 'Segmentation' }], chosen: null, model: 'model-a', reason: null, outcome: 'none', at: '2026-01-01T00:00:01Z' }]; // fmt: skip
      await boot({
        run: existingRun({
          cursor: 2,
          results: {
            a: [{ content: 'A0', model: 'model-a', demo: false, error: false, decision_trace: trace }, { content: 'A1', model: 'model-a', demo: false, error: false, decision_trace: null }],
            b: [{ content: 'B0', model: 'model-b', demo: false, error: false, decision_trace: null }, { content: 'B1', model: 'model-b', demo: false, error: false, decision_trace: null }],
          },
        }),
      });
      await click('step-replay');
      const entries = [...document.querySelectorAll('.result-entry')];
      expect(entries[0].querySelector('.decision-tree summary').textContent).toContain('2 steps');
      expect(entries[0].querySelector('.decision-step.unresolved b').textContent).toBe('Nothing relevant');
      expect(entries[1].querySelector('.decision-tree')).toBeNull(); // no walk recorded: nothing shown
      document.querySelector('[data-result="b"]').click();
      expect(document.querySelector('.result-entry .decision-tree')).toBeNull();
    });

    it('starts a run from the current chat when there is none', async () => {
      const { mock } = await boot();
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({});
      expect(document.querySelectorAll('.prompt-row')).toHaveLength(3);
      openConfig();
      expect($('model-a').value).toBe('model-a');
      expect($('model-b').value).toBe('model-b');
    });

    it('starts a new run from the chat when the existing run is empty', async () => {
      const { mock } = await boot({ run: existingRun({ prompts: [] }) });
      expect(mock.called('POST /api/replay-runs')).toBe(true);
      expect(document.querySelectorAll('.prompt-row')).toHaveLength(3);
    });

    it('replaces a run that has not started and belongs to no chat, so it cannot hide the current chat', async () => {
      const { mock } = await boot({ run: existingRun({ source_conversation_id: null, prompts: ['an old sample prompt'] }) });
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({});
      expect([...document.querySelectorAll('.prompt-row p')].map(text)).toEqual(['first prompt', 'second prompt', 'third prompt']);
    });

    it('keeps a run that has started even when it belongs to no chat', async () => {
      const { mock } = await boot({
        run: existingRun({ source_conversation_id: null, prompts: ['old'], cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] } }),
      });
      expect(mock.called('POST /api/replay-runs')).toBe(false);
      expect([...document.querySelectorAll('.prompt-row p')].map(text)).toEqual(['old']);
    });

    it('keeps an existing run that has prompts (no new run)', async () => {
      const { mock } = await boot({ run: existingRun() });
      expect(mock.called('POST /api/replay-runs')).toBe(false);
    });

    it('fixes models that are no longer configured, but only before the run has started', async () => {
      const { mock } = await boot({ run: existingRun({ model_a: 'removed-1', model_b: 'model-b' }) });
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ model_a: 'model-a', model_b: 'model-b' });
      openConfig();
      expect($('model-a').value).toBe('model-a');
    });

    it('starts with the prompts panel closed and remembers when it is opened', async () => {
      const { mock } = await boot({ run: existingRun() });
      expect($('replay-layout').classList.contains('prompts-hidden')).toBe(true);
      expect($('prompts-slot').hasAttribute('inert')).toBe(true);
      await click('show-prompts');
      expect($('replay-layout').classList.contains('prompts-hidden')).toBe(false);
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ replay_prompts_hidden: false });
      await click('hide-prompts');
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ replay_prompts_hidden: true });
    });

    it('opens the panel when the saved preference says so', async () => {
      await boot({ run: existingRun(), appOverrides: { preferences: { agent_id: 'assistant', model: null, chat_sidebar_hidden: false, replay_prompts_hidden: false } } });
      expect($('replay-layout').classList.contains('prompts-hidden')).toBe(false);
    });

    it('shows a retryable error when the page cannot load', async () => {
      vi.resetModules();
      document.body.innerHTML = '';
      setUnauthorizedHandler(vi.fn());
      const { routes } = appRoutes();
      mockApi({ ...routes, 'GET /api/conversations/current': apiError(500, 'oops', 'The server hit a problem.'), 'GET /api/saved-replays': [], 'GET /api/replay-runs/current': apiError(404, 'not_found', 'none') });
      await import('./replay-controller.js');
      await settle();
      expect(text(document.querySelector('[role="alert"]'))).toContain('The server hit a problem.');
    });
  });

  describe('configuring', () => {
    it('lets the same model be used for both slots', async () => {
      const { mock } = await boot({ run: existingRun() });
      openConfig();
      $('model-b').value = 'model-a';
      $('model-b').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ model_a: 'model-a', model_b: 'model-a' });
      expect($('model-b').value).toBe('model-a');
    });

    it('waits for a change that is still in flight before it starts stepping', async () => {
      const { server } = await boot({ run: existingRun() });
      server.order.length = 0; // forget the page's own start-up requests
      server.holdPatch = true;
      openConfig();
      $('replay-agent').value = 'research';
      $('replay-agent').dispatchEvent(new Event('change')); // the server is slow to answer
      $('play-replay').click(); // and the user presses Play straight away
      await settle();
      expect(server.order).toEqual(['patch']); // no step was sent yet
      server.releasePatch();
      await settle(10);
      expect(server.order.slice(0, 2)).toEqual(['patch', 'step']); // the change was applied first
      expect(server.runs[0].agent_id).toBe('research');
      expect(text($('run-status'))).toBe('Replay complete'); // and the late answer did not undo any progress
    });

    it('changes the agent', async () => {
      const { mock } = await boot({ run: existingRun() });
      openConfig();
      $('replay-agent').value = 'research';
      $('replay-agent').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ agent_id: 'research' });
      expect($('replay-agent').value).toBe('research');
    });

    it('snaps the controls back and shows the reason when the server refuses a change before the replay starts', async () => {
      const { server } = await boot({ run: existingRun() });
      openConfig();
      server.runs.at(-1).cursor = 1; // the run moved on behind the page's back: the server refuses the update
      $('model-a').value = 'model-c';
      $('model-a').dispatchEvent(new Event('change'));
      await settle();
      expect(toastText()).toBe('Models and agent are locked once a replay has started. Reset to change them.');
      expect($('model-a').value).toBe('model-a');
    });
  });

  describe('the KB summary tool and reasoning level', () => {
    const chatConfig = { name: 'Design chat', agent_id: 'code', model: 'model-b', reasoning_level: 'low', kb_summary_tool: true };
    const startedRun = (extra = {}) => existingRun({ cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] }, ...extra }); // fmt: skip

    it('shows the current chat\'s settings, read-only, above the controls', async () => {
      await boot({ run: existingRun(), chatConfig });
      openConfig();
      const note = document.querySelector('.source-chat');
      expect(text(note)).toContain('Design chat');
      const chips = Object.fromEntries([...note.querySelectorAll('.config-list li')].map((c) => [c.querySelector('b').textContent.toUpperCase(), c.childNodes[1].textContent]));
      expect(chips).toEqual({ AGENT: 'Code assistant', MODEL: 'model-b', REASONING: 'Low', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On', 'BRIEF REPLIES': 'Off' });
      expect(note.querySelector('ul.config-list')).not.toBeNull(); // a bullet list, not chips
      expect(note.querySelectorAll('.chip')).toHaveLength(0);
      expect(note.querySelector('select, input')).toBeNull(); // nothing to change here
    });

    it('a replay started from the chat begins from its settings', async () => {
      const { mock } = await boot({ chatConfig }); // no run yet: one is started from the current chat
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({});
      openConfig();
      expect($('replay-kb-summary').checked).toBe(true);
      expect($('replay-reasoning').value).toBe('none'); // reasoning starts off on a replay, whatever the chat used
      expect(text(document.querySelector('.source-chat'))).toContain('Low'); // the chat's own level is still shown
      expect($('replay-agent').value).toBe('code');
    });

    it('is off, with default reasoning, when the chat has no such settings', async () => {
      await boot({ run: existingRun() });
      openConfig();
      expect($('replay-kb-summary').checked).toBe(false);
      expect($('replay-reasoning').value).toBe('default');
    });

    it('one switch for the whole run: changing it or the reasoning level is sent to the server', async () => {
      const { mock } = await boot({ run: existingRun() });
      openConfig();
      expect(document.querySelectorAll('input[id^="replay-kb-summary"]')).toHaveLength(1); // not one per slot
      $('replay-kb-summary').checked = true;
      $('replay-kb-summary').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ kb_summary_tool: true });
      expect($('replay-kb-summary').checked).toBe(true);
      $('replay-reasoning').value = 'high';
      $('replay-reasoning').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ reasoning_level: 'high' });
      expect($('replay-reasoning').value).toBe('high');
    });

    it('can still be changed once the replay has started (that resets it), and Reset keeps them', async () => {
      const { mock } = await boot({ run: finishedRun({ kb_summary_tool: true, reasoning_level: 'medium' }) });
      openConfig();
      expect($('replay-kb-summary').disabled).toBe(false);
      expect($('replay-reasoning').disabled).toBe(false);
      await click('reset-replay');
      expect(mock.lastBody('POST /api/replay-runs')).toMatchObject({ kb_summary_tool: true, reasoning_level: 'medium' });
      expect($('replay-kb-summary').disabled).toBe(false);
      expect($('replay-kb-summary').checked).toBe(true);
    });

    it('each slot\'s own summary is shown with its result, and a deleted version is flagged', async () => {
      const results = {
        a: [{ content: 'A0', model: 'model-a', demo: false, error: false, kb_summary: 'summary by model-a', kb_version_deleted: true }],
        b: [{ content: 'B0', model: 'model-b', demo: false, error: false, kb_summary: 'summary by model-b' }],
      };
      await boot({ run: startedRun({ kb_summary_tool: true, results }) });
      await click('step-replay');
      expect(text(document.querySelector('.result-entry .kb-summary-text'))).toBe('summary by model-a');
      expect(text(document.querySelector('.result-entry .kb-deleted-flag'))).toContain('has been deleted');
      document.querySelector('[data-result="b"]').click();
      expect(text(document.querySelector('.result-entry .kb-summary-text'))).toBe('summary by model-b');
      expect(document.querySelector('.result-entry .kb-deleted-flag')).toBeNull();
    });

    it('the Diff shows which setting each replay used and what each model was handed instead of the file', async () => {
      const mk = (id, tool, level) =>
        existingRun({ id, saved_at: '2026-01-10T00:00:00Z', prompts: ['first prompt'], cursor: 1, kb_summary_tool: tool, reasoning_level: level,
          results: { a: [{ content: 'one', model: 'model-a', demo: true, error: false, kb_summary: tool ? 'summary by model-a' : null }], b: [{ content: 'two', model: 'model-b', demo: true, error: false, kb_summary: tool ? 'summary by model-b' : null, kb_version_deleted: true }] } }); // fmt: skip
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [mk('r1', false, 'default'), mk('r2', true, 'high')] });
      await openTab('diff');
      const badges = [...document.querySelectorAll('.diff-settings .badge')].map(text);
      expect(badges).toEqual([
        'A · Model model-a', 'A · KB summary tool on', 'A · Brief replies off', 'A · Reasoning High', 'A · Temperature 0', 'A · Log probabilities off',
        'B · Model model-b', 'B · KB summary tool on', 'B · Brief replies off', 'B · Reasoning High', 'B · Temperature 0', 'B · Log probabilities off',
      ]);
      // only what differs between A and B is highlighted: here the models
      expect([...document.querySelectorAll('.diff-settings .badge.diff-changed')].map(text)).toEqual(['A · Model model-a', 'B · Model model-b']);
      expect([...document.querySelectorAll('.diff-response .kb-summary-text')].map(text)).toEqual(['summary by model-a', 'summary by model-b']);
      expect(document.querySelectorAll('.diff-response .kb-deleted-flag')).toHaveLength(1);
      await openTab('history');
      const rows = [...document.querySelectorAll('.record-detail')].map(text).join('|');
      expect(rows).toContain('Temperature 0 · Reasoning High');
      expect(rows).toContain('KB summary tool on');
      expect(rows).toContain('Temperature 0 · Reasoning Default');
      expect(rows).toContain('KB summary tool off');
    });
  });

  describe('stepping and playing', () => {
    it('steps one prompt on both models, with the expected cursor', async () => {
      const { mock } = await boot({ run: existingRun() });
      await click('step-replay');
      expect(mock.lastBody('POST /api/replay-runs/:id/steps')).toEqual({ expected_cursor: 0, request_id: expect.stringMatching(ID) });
      expect(progress()).toContain('1 / 3 prompts');
      expect(text(document.querySelector('.result-entry'))).toContain('A0');
      await click('step-replay');
      expect(mock.lastBody('POST /api/replay-runs/:id/steps')).toEqual({ expected_cursor: 1, request_id: expect.stringMatching(ID) });
      document.querySelector('[data-result="b"]').click();
      expect([...document.querySelectorAll('.result-entry .message-copy')].map(text)).toEqual(['B0', 'B1']);
    });

    it('Play all shows a spinner popup with the replay number, then View Diff, and no Model responses panel', async () => {
      const { server } = await boot({ run: existingRun() });
      expect(document.querySelector('.results')).toBeNull();
      server.hold = true;
      $('play-replay').click();
      await settle();
      expect(text(document.querySelector('.play-overlay h2'))).toBe('Replay v1 is running');
      expect(document.querySelector('.play-spinner')).not.toBeNull();
      expect($('view-diff-chat')).toBeNull();
      expect([...document.querySelectorAll('.play-models li')].map(text)).toEqual(['Amodel-a', 'Bmodel-b']);
      expect(text(document.querySelector('.play-settings'))).toContain('Log probsOff');
      server.hold = false;
      server.release();
      await settle(10);
      expect(text(document.querySelector('.play-overlay h2'))).toBe('Replay v1 complete');
      expect(document.querySelector('.play-spinner')).toBeNull();
      expect(document.querySelector('.results')).toBeNull(); // only Step through shows the panel
      await click('view-diff-api');
      expect(document.querySelector('.play-overlay')).toBeNull();
      expect($('tab-diff').getAttribute('aria-selected')).toBe('true');
      expect($('diff-view-api').getAttribute('aria-selected')).toBe('true'); // Diff API opens the API logs view
    });

    it('Stop in the Play all popup closes it without offering View Diff', async () => {
      const { server } = await boot({ run: existingRun() });
      server.hold = true;
      $('play-replay').click();
      await settle();
      await click('stop-play');
      await settle(10);
      expect(document.querySelector('.play-overlay')).toBeNull();
    });

    it('plays everything, then shows the finished run in the saved replays', async () => {
      const { mock } = await boot({ run: existingRun() });
      await click('play-replay');
      await settle(10);
      expect(text($('run-status'))).toBe('Replay complete');
      expect(mock.count('POST /api/replay-runs/:id/steps')).toBe(3);
      await openTab('history');
      expect(document.body.textContent).toContain('1 version');
      expect(document.body.textContent).toContain('Replay v1');
      expect(document.body.textContent).toContain('3 / 3 prompts');
    });

    it('stops playback: the stop command reaches the server, then the page re-syncs with what it kept', async () => {
      const { server, mock } = await boot({ run: existingRun() });
      server.hold = true;
      await click('play-replay');
      expect($('play-replay').textContent).toContain('Stop playback');
      await click('play-replay'); // Stop playback
      expect(server.order.slice(-3)).toEqual(['step', 'stop', 'sync']);
      const stepId = mock.lastBody('POST /api/replay-runs/:id/steps').request_id;
      expect(mock.lastBody('POST /api/replay-runs/:id/stop')).toEqual({ request_id: stepId }); // names the step in flight
      expect(toastText()).toBe('Playback stopped. Resume from this prompt.');
      expect(progress()).toContain('0 / 3 prompts');
      expect($('play-replay').textContent).toContain('Play all');
      expect($('step-replay').disabled).toBe(false);
    });

    it('shows the server error and keeps the run when a step fails', async () => {
      await boot({ run: existingRun(), stepFailure: apiError(502, 'llm_http_error', 'API returned HTTP 500. Check your key, model ID, and endpoint in Account.') });
      await click('play-replay');
      await settle(10);
      expect(toastText()).toBe('API returned HTTP 500. Check your key, model ID, and endpoint in Account.');
      expect(progress()).toContain('0 / 3 prompts');
      expect($('play-replay').textContent).toContain('Play all');
    });

    it('re-syncs after a stale-cursor conflict', async () => {
      const { server } = await boot({ run: existingRun() });
      server.runs[0].cursor = 1; // moved on in another tab
      server.runs[0].results = { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] };
      await click('step-replay');
      expect(toastText()).toBe('This replay has moved on. Reload it and try again.');
      expect(progress()).toContain('1 / 3 prompts');
    });
  });

  describe('reset, save and load', () => {
    const started = () => existingRun({ cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] } });

    it('reset starts a new run with the same prompts, models and agent', async () => {
      const { mock } = await boot({ run: finishedRun() });
      await click('reset-replay');
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({ prompts: ['first prompt', 'second prompt', 'third prompt'], model_a: 'model-a', model_b: 'model-b', agent_id: 'assistant', kb_summary_tool: false, reasoning_level: 'default', temperature: 0, logprobs: false, brief_replies: false, source_conversation_id: 'c1' }); // stays tied to its chat
      expect(progress()).toContain('0 / 3 prompts');
      openConfig();
      expect($('model-a').disabled).toBe(false);
    });

    it('reset keeps the old run as a saved replay', async () => {
      await boot({ run: finishedRun() });
      await click('reset-replay');
      await openTab('history');
      expect(document.body.textContent).toContain('1 version');
    });

    it('shows only Reset, Diff API and Diff Chat once every prompt has been sent, and only Step through, Play all and Config before that', async () => {
      await boot({ run: started() });
      const ids = () => [...document.querySelectorAll('.replay-controls button')].map((b) => b.id);
      expect(ids()).toEqual(['step-replay', 'play-replay', 'open-config']); // no Reset part way through
      await boot({ run: finishedRun() });
      expect(ids()).toEqual(['reset-replay', 'diff-api-btn', 'diff-chat-btn']); // Reset with the two Diff buttons beside it, nothing else
      await boot({ run: existingRun() });
      expect(ids()).toEqual(['step-replay', 'play-replay', 'open-config']);
    });

    it('swaps to Reset when the last prompt is stepped, and back to the others after Reset', async () => {
      await boot({ run: finishedRun({ cursor: 2, saved_at: null, results: { a: finishedRun().results.a.slice(0, 2), b: finishedRun().results.b.slice(0, 2) } }) });
      expect($('reset-replay')).toBeNull();
      await click('step-replay');
      expect($('reset-replay')).not.toBeNull();
      expect($('step-replay')).toBeNull();
      expect($('play-replay')).toBeNull();
      expect($('open-config')).toBeNull();
      await click('reset-replay');
      expect($('reset-replay')).toBeNull();
      expect($('step-replay')).not.toBeNull();
    });

    it('Diff API and Diff Chat beside Reset open the Diff tab on the API logs or the chat view', async () => {
      await boot({ run: finishedRun() });
      await click('diff-api-btn');
      expect($('tab-diff').getAttribute('aria-selected')).toBe('true');
      expect($('diff-view-api').getAttribute('aria-selected')).toBe('true');
      await openTab('replay');
      await click('diff-chat-btn');
      expect($('tab-diff').getAttribute('aria-selected')).toBe('true');
      expect($('diff-view-chat').getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('Config replaces Save replay, and changing it after a run resets the replay', () => {
    const started = (extra = {}) => existingRun({ cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] }, ...extra }); // fmt: skip
    const change = async (id, value) => {
      const el = $(id);
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
      el.dispatchEvent(new Event('change'));
      await settle();
    };
    const posts = (mock) => mock.calls.filter((c) => c.key === 'POST /api/replay-runs');
    const modalEl = () => document.querySelector('.modal');

    it('has a Config button where Save replay was, and it opens the Config popup', async () => {
      await boot({ run: started() });
      expect($('save-replay')).toBeNull();
      const button = $('open-config');
      expect(text(button)).toBe('Config');
      expect(button.closest('.replay-controls')).not.toBeNull();
      expect(button.previousElementSibling).toBe($('play-replay')); // right of Play all
      expect(button.disabled).toBe(false);
      button.click();
      await settle();
      expect(text(modalEl().querySelector('h2'))).toBe('Config');
      expect($('replay-agent')).not.toBeNull();
    });

    it('opens it even while a replay is running, with its settings greyed out', async () => {
      const { server } = await boot({ run: existingRun() });
      server.hold = true;
      $('play-replay').click();
      await settle();
      expect($('open-config').disabled).toBe(false);
      $('open-config').click();
      await settle();
      expect($('replay-temperature').disabled).toBe(true);
      expect($('model-a').disabled).toBe(true);
      server.release();
    });

    it('lets the user change every setting after the run has started, and says what that does', async () => {
      await boot({ run: started() });
      openConfig();
      for (const id of ['replay-agent', 'replay-reasoning', 'replay-temperature', 'replay-kb-summary', 'replay-logprobs', 'model-a', 'model-b']) {
        expect($(id).disabled, id).toBe(false);
      }
      expect(text(document.querySelector('.config-reset-note'))).toContain('Changing any setting resets it');
      expect(text(document.querySelector('.config-reset-note'))).toContain('saved replay');
    });

    it('shows no reset note before the replay has started', async () => {
      await boot({ run: existingRun() });
      openConfig();
      expect(document.querySelector('.config-reset-note')).toBeNull();
    });

    it('resets the replay with the new setting: a new run, same prompts, nothing else changed', async () => {
      const { mock } = await boot({ run: started({ source_conversation_id: 'c1' }) });
      openConfig();
      await change('replay-agent', 'research');
      expect(posts(mock)).toHaveLength(1);
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({
        prompts: ['first prompt', 'second prompt', 'third prompt'], model_a: 'model-a', model_b: 'model-b', agent_id: 'research',
        kb_summary_tool: false, reasoning_level: 'default', temperature: 0, logprobs: false, brief_replies: false, source_conversation_id: 'c1',
      }); // fmt: skip
      expect(mock.called('PATCH /api/replay-runs/:id')).toBe(false); // not an update of the started run
      expect(progress()).toContain('0 / 3 prompts');
      expect($('replay-agent').value).toBe('research');
      expect($('replay-agent').disabled).toBe(false);
      expect(document.querySelector('.config-reset-note')).toBeNull(); // the new run has not started
      expect(toastText()).toBe('Config changed, so the replay was reset. The results so far are saved. Start a new run.');
    });

    it.each([
      ['replay-reasoning', 'high', { reasoning_level: 'high' }],
      ['replay-temperature', '1.4', { temperature: 1.4 }],
      ['replay-temperature', '0', { temperature: 0 }],
      ['replay-kb-summary', true, { kb_summary_tool: true }],
      ['replay-logprobs', true, { logprobs: true }],
      ['replay-brief', true, { brief_replies: true }],
      ['model-a', 'model-c', { model_a: 'model-c' }],
      ['model-b', 'model-a', { model_b: 'model-a' }],
    ])('changing %s to %s after the run resets it with that change only', async (id, value, expected) => {
      const { mock } = await boot({ run: started({ temperature: 0.5 }) });
      openConfig();
      await change(id, value);
      const base = { prompts: ['first prompt', 'second prompt', 'third prompt'], model_a: 'model-a', model_b: 'model-b', agent_id: 'assistant', kb_summary_tool: false, reasoning_level: 'default', temperature: 0.5, logprobs: false, brief_replies: false, source_conversation_id: 'c1' }; // fmt: skip
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({ ...base, ...expected });
      expect(progress()).toContain('0 / 3 prompts');
    });

    it('keeps the old run as a saved replay version, and the replay ready to play again', async () => {
      const { mock } = await boot({ run: started() });
      openConfig();
      await change('replay-reasoning', 'low');
      await openTab('history');
      expect(document.body.textContent).toContain('1 version');
      expect(document.body.textContent).toContain('Partial replay');
      await openTab('replay');
      expect($('play-replay').disabled).toBe(false);
      expect($('step-replay').disabled).toBe(false);
      await click('play-replay');
      await settle(10);
      expect(mock.count('POST /api/replay-runs/:id/steps')).toBe(3); // a fresh run plays all three prompts
    });

    it('resets a finished replay too', async () => {
      const done = started({ cursor: 3, saved_at: '2026-01-10T00:00:00Z' });
      const { mock } = await boot({ run: done });
      openConfig();
      await change('replay-temperature', '0.8');
      expect(posts(mock)).toHaveLength(1);
      expect(progress()).toContain('0 / 3 prompts');
    });

    it('only updates the run in place while it has not started', async () => {
      const { mock } = await boot({ run: existingRun() });
      openConfig();
      await change('replay-temperature', '1');
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ temperature: 1 });
      expect(posts(mock)).toHaveLength(0);
      expect(toastText() ?? '').not.toContain('reset');
    });

    it('stays on the tab the user is on, and the popup stays open with the new value', async () => {
      await boot({ run: started() });
      await openTab('history');
      $('file-menu-btn').click();
      $('file-config').click();
      await settle();
      await change('replay-temperature', '0.3');
      expect($('tab-history').getAttribute('aria-selected')).toBe('true');
      expect(modalEl()).not.toBeNull();
      expect($('replay-temperature').value).toBe('0.3');
    });

    it('puts the controls back and says why when the reset cannot be made', async () => {
      const { server, mock } = await boot({ run: started() });
      openConfig();
      server.failCreate = apiError(500, 'oops', 'The server hit a problem.');
      await change('replay-reasoning', 'high');
      expect(toastText()).toContain('The server hit a problem.');
      expect($('replay-reasoning').value).toBe('default'); // back to what the run has
      expect(progress()).toContain('1 / 3 prompts'); // the started run is untouched
      expect(posts(mock)).toHaveLength(1);
    });

    it('queues changes: of two quick edits the first resets the replay and the second updates the fresh run', async () => {
      const { mock } = await boot({ run: started() });
      openConfig();
      $('replay-reasoning').value = 'high';
      $('replay-reasoning').dispatchEvent(new Event('change'));
      $('replay-temperature').value = '0.9';
      $('replay-temperature').dispatchEvent(new Event('change'));
      await settle(5);
      expect(posts(mock)).toHaveLength(1); // one reset, for the first change
      expect(posts(mock)[0].body.reasoning_level).toBe('high');
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ temperature: 0.9 }); // the new run has not started, so it is updated in place
      expect($('replay-reasoning').value).toBe('high');
      expect($('replay-temperature').value).toBe('0.9');
    });

    it('does not reset for an invalid temperature', async () => {
      const { mock } = await boot({ run: started() });
      openConfig();
      await change('replay-temperature', '9');
      expect(posts(mock)).toHaveLength(0);
      expect(toastText()).toBe('Temperature must be a number from 0 to 2.');
    });
  });

  describe('log probabilities', () => {
    const started = () => existingRun({ cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] } }); // fmt: skip

    it('has a toggle in the Config popup, off by default, drawn as a switch', async () => {
      await boot({ run: existingRun() });
      openConfig();
      expect($('replay-logprobs').checked).toBe(false);
      expect($('replay-logprobs').classList.contains('switch')).toBe(true);
      expect(text(document.querySelector('label[for="replay-logprobs"]'))).toContain('Log probabilities');
    });

    it('has a Brief replies switch in Config that sends brief_replies, on and off', async () => {
      const { mock } = await boot({ run: existingRun() });
      openConfig();
      expect($('replay-brief').checked).toBe(false);
      expect(text(document.querySelector('label[for="replay-brief"]'))).toContain('Brief replies');
      $('replay-brief').checked = true;
      $('replay-brief').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ brief_replies: true });
      expect($('replay-brief').checked).toBe(true);
      $('replay-brief').checked = false;
      $('replay-brief').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ brief_replies: false });
    });

    it('sends the switch to the server, on and off, and shows it as set', async () => {
      const { mock } = await boot({ run: existingRun() });
      openConfig();
      $('replay-logprobs').checked = true;
      $('replay-logprobs').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ logprobs: true });
      expect($('replay-logprobs').checked).toBe(true);
      $('replay-logprobs').checked = false;
      $('replay-logprobs').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ logprobs: false });
      expect($('replay-logprobs').checked).toBe(false);
    });

    it('starts from the run (on when the run asks for them) and stays editable once the replay has started', async () => {
      await boot({ run: existingRun({ logprobs: true }) });
      openConfig();
      expect($('replay-logprobs').checked).toBe(true);
      expect($('replay-logprobs').disabled).toBe(false);
      await boot({ run: started() });
      openConfig();
      expect($('replay-logprobs').disabled).toBe(false); // changing it resets the replay instead
    });

    it('is kept by Reset', async () => {
      const { mock } = await boot({ run: finishedRun({ logprobs: true }) });
      await click('reset-replay');
      expect(mock.lastBody('POST /api/replay-runs').logprobs).toBe(true);
    });

    const withTokens = (id, logprobs, contentA = 'Plan the launch', contentB = 'Plan the launch') =>
      existingRun({ id, saved_at: '2026-01-10T00:00:00Z', logprobs, prompts: ['p'], cursor: 1, results: { a: [{ content: contentA, model: 'model-a', demo: false, error: false }], b: [{ content: contentB, model: 'model-b', demo: false, error: false }] } }); // fmt: skip
    const cliffTokens = [{ token: 'Plan', logprob: -0.1 }, { token: ' the', logprob: -0.2 }, { token: ' launch', logprob: -4.2 }];

    it('fetches the answer tokens for a replay that asked for them and marks the cliffs in red with their value', async () => {
      const { server, mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true), withTokens('r2', true)] });
      server.logprobTokens = { a: cliffTokens, b: null };
      await openTab('diff');
      const asked = mock.calls.filter((c) => c.key === 'GET /api/saved-replays/:id/logprobs').map((c) => decodeURIComponent(c.path.split('/').at(-2)));
      expect(asked.sort()).toEqual(['r2:a', 'r2:b']); // the two selected replays, once each
      const cliffs = [...document.querySelectorAll('.diff-turn .diff-cell.a .logprob-cliff')];
      expect(cliffs.map(text)).toEqual([' launch']);
      expect(cliffs[0].dataset.cliffTip.split('\n')[0]).toBe('Log prob cliff: 4.00');
      expect(document.querySelectorAll('.diff-turn .diff-cell.b .logprob-cliff')).toHaveLength(0);
      expect(text(document.querySelector('.diff-turn .result-label span:last-child'))).toBe('Unchanged · 1 log prob cliff');
      expect(document.querySelector('.hover-tip')).not.toBeNull();
    });

    it('does not ask for tokens a replay never requested', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', false), withTokens('r2', false)] });
      await openTab('diff');
      expect(mock.called('GET /api/saved-replays/:id/logprobs')).toBe(false);
      expect(document.querySelector('.logprob-cliff')).toBeNull();
    });

    it('still opens the comparison, without cliffs, when the tokens cannot be loaded', async () => {
      const { server, mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true), withTokens('r2', true)] });
      server.failLogprobs = apiError(500, 'oops', 'The server hit a problem.');
      await openTab('diff');
      expect(document.querySelectorAll('.diff-turn')).toHaveLength(1);
      expect(document.querySelector('.logprob-cliff')).toBeNull();
      const asked = mock.calls.filter((c) => c.key === 'GET /api/saved-replays/:id/logprobs').length;
      expect(asked).toBe(2); // one attempt each, not a retry loop
    });

    it('draws the divergence inside the word marks when the answers differ, where it beats a cliff on the same word', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true, 'Plan the launch', 'Plan the rollout'), withTokens('r2', true, 'Plan the launch', 'Plan the rollout')] });
      server.logprobTokens = { a: cliffTokens, b: [{ token: 'Plan', logprob: -0.1 }, { token: ' the', logprob: -0.2 }, { token: ' rollout', logprob: -0.3 }] };
      await openTab('diff');
      expect(document.querySelector('.diff-turn .diff-cell.a mark.diff-removed .logprob-diverge')).not.toBeNull();
      expect(document.querySelectorAll('.diff-turn .diff-cell.a .logprob-cliff')).toHaveLength(0); // ' launch' is a cliff too, but purple wins
      expect(text(document.querySelector('.diff-turn .diff-row:not(.diff-head) .diff-cell.a'))).toBe('Plan the launch');
    });

    it('marks where the two replays\' answers first diverge, on the page, with the note above', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true, 'Plan the launch', 'Plan the rollout'), withTokens('r2', true, 'Plan the launch', 'Plan the rollout')] });
      server.logprobTokens = { a: [{ token: 'Plan', logprob: -0.1 }, { token: ' the', logprob: -0.1 }, { token: ' launch', logprob: -0.42 }], b: [{ token: 'Plan', logprob: -0.1 }, { token: ' the', logprob: -0.1 }, { token: ' rollout', logprob: -1.05 }] };
      await openTab('diff');
      const pieces = (side) => [...document.querySelectorAll(`.diff-turn .diff-row:not(.diff-head) .diff-cell.${side} .logprob-diverge`)].map(text).join('');
      expect(pieces('a')).toBe(' launch');
      expect(pieces('b')).toBe(' rollout');
      expect(text(document.querySelector('.diverge-note'))).toBe('Answers diverge at token 3: A chose " launch": 66% likely (log prob -0.42); B chose " rollout": 35% likely (log prob -1.05).');
      expect(document.querySelectorAll('.logprob-cliff')).toHaveLength(0); // no cliff here: it was a close call
    });

    it('has an adjustable cliff threshold: lowering it flags more, using the tokens already loaded', async () => {
      const { server, mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true), withTokens('r2', true)] });
      server.logprobTokens = { a: [{ token: 'Plan', logprob: -0.1 }, { token: ' the', logprob: -1.3 }, { token: ' launch', logprob: -2.7 }], b: null };
      await openTab('diff');
      expect($('cliff-threshold')).toBeNull(); // it lives in the gear's popup
      await click('diff-settings');
      expect(document.querySelector('.modal h2').textContent).toBe('Diff settings');
      expect($('cliff-threshold').value).toBe('2');
      const red = () => [...document.querySelectorAll('.diff-turn .diff-cell.a .logprob-cliff')].map(text).join('|');
      expect(red()).toBe(''); // drops of 1.2 and 1.4: below 2
      const before = mock.calls.length;
      $('cliff-threshold').value = '1';
      $('cliff-threshold').dispatchEvent(new Event('change'));
      await settle();
      expect(red()).toBe(' the| launch');
      expect($('cliff-threshold').value).toBe('1'); // the box keeps what was typed
      expect(document.activeElement).toBe($('cliff-threshold'));
      expect(mock.calls.length).toBe(before); // nothing was fetched again
      expect(text(document.querySelector('.diff-turn .result-label span:last-child'))).toBe('Unchanged · 2 log prob cliffs');
      $('cliff-threshold').value = '1.3';
      $('cliff-threshold').dispatchEvent(new Event('change'));
      await settle();
      expect(red()).toBe(' launch'); // 1.4 still counts, 1.2 does not
    });

    it('keeps the threshold when the comparison is redrawn, and refuses a bad one with a note', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true), withTokens('r2', true)] });
      server.logprobTokens = { a: cliffTokens, b: null };
      await openTab('diff');
      await click('diff-settings');
      $('cliff-threshold').value = '3';
      $('cliff-threshold').dispatchEvent(new Event('change'));
      await settle();
      closeModal();
      await openTab('replay');
      await openTab('diff');
      await click('diff-settings');
      expect($('cliff-threshold').value).toBe('3');
      for (const bad of ['', '0', '-2', '21', 'abc']) {
        $('cliff-threshold').value = bad;
        $('cliff-threshold').dispatchEvent(new Event('change'));
        await settle();
        expect(toastText()).toBe('The cliff threshold must be a number above 0, up to 20.');
        expect($('cliff-threshold').value).toBe('3'); // the last good value is back
      }
    });

    it('says when log probabilities were asked for but none came back', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [withTokens('r1', true), withTokens('r2', true)] });
      server.logprobTokens = null; // the server has none for either slot
      await openTab('diff');
      expect([...document.querySelectorAll('.diff-turn .result-label span:last-child')].map(text)).toEqual(['Unchanged · no log probabilities returned', 'Unchanged · no log probabilities returned']);
    });

    it('shows in the Diff only for a replay that asked for log probabilities', async () => {
      const run = (id, logprobs) => existingRun({ id, saved_at: '2026-01-10T00:00:00Z', logprobs, prompts: ['p'], cursor: 1, results: { a: [{ content: 'one', model: 'model-a', demo: true, error: false }], b: [{ content: 'two', model: 'model-b', demo: true, error: false }] } }); // fmt: skip
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1', false), run('r2', true)] });
      await openTab('diff');
      const badges = [...document.querySelectorAll('.diff-settings .badge')].map(text);
      expect(badges).toContain('A · Log probabilities on');
      expect(badges).toContain('B · Log probabilities on');
      expect(badges.filter((b) => b.includes('Log probabilities'))).toHaveLength(2); // only the replay that asked
    });
  });

  describe('temperature', () => {
    const started = () => existingRun({ cursor: 1, results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [{ content: 'B0', model: 'model-b', demo: true, error: false }] } }); // fmt: skip

    it('starts from the chat\'s temperature (0 by default) and shows it in Config', async () => {
      await boot({ run: existingRun() });
      openConfig();
      expect($('replay-temperature').value).toBe('0');
      expect(text(document.querySelector('.source-chat'))).toContain('Temperature0');
      await boot({ chatConfig: { temperature: 0.8 } });
      openConfig();
      expect($('replay-temperature').value).toBe('0.8');
      expect(text(document.querySelector('.source-chat'))).toContain('Temperature0.8');
    });

    it('sends a changed temperature to the server, zero included', async () => {
      const { mock } = await boot({ run: existingRun({ temperature: 1 }) });
      openConfig();
      $('replay-temperature').value = '0';
      $('replay-temperature').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ temperature: 0 });
      expect($('replay-temperature').value).toBe('0');
      $('replay-temperature').value = '1.6';
      $('replay-temperature').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ temperature: 1.6 });
      expect($('replay-temperature').value).toBe('1.6');
    });

    it('refuses a temperature outside 0 to 2 without calling the server, and puts the old value back', async () => {
      const { mock } = await boot({ run: existingRun({ temperature: 0.5 }) });
      openConfig();
      const patches = () => mock.calls.filter((c) => c.key === 'PATCH /api/replay-runs/:id').length;
      for (const bad of ['', '3', '-0.5', 'abc']) {
        $('replay-temperature').value = bad;
        $('replay-temperature').dispatchEvent(new Event('change'));
        await settle();
        expect(toastText()).toBe('Temperature must be a number from 0 to 2.');
        expect($('replay-temperature').value).toBe('0.5');
      }
      expect(patches()).toBe(0);
    });

    it('stays editable once the replay has started, and Reset keeps it', async () => {
      const { mock } = await boot({ run: finishedRun() });
      openConfig();
      expect($('replay-temperature').disabled).toBe(false);
      await click('reset-replay');
      expect(mock.lastBody('POST /api/replay-runs').temperature).toBe(0);
      expect($('replay-temperature').disabled).toBe(false);
    });

    it('shows the temperature each replay used in the Diff and in the saved replays', async () => {
      const run = (id, temperature) => existingRun({ id, saved_at: '2026-01-10T00:00:00Z', temperature, prompts: ['p'], cursor: 1, results: { a: [{ content: 'one', model: 'model-a', demo: true, error: false }], b: [{ content: 'two', model: 'model-b', demo: true, error: false }] } }); // fmt: skip
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1', 0), run('r2', 1.2)] });
      await openTab('diff');
      expect([...document.querySelectorAll('.diff-settings .badge')].map(text).filter((t) => t.includes('Temperature'))).toEqual(['A · Temperature 1.2', 'B · Temperature 1.2']);
      await openTab('history');
      expect(document.body.textContent).toContain('Temperature 1.2');
      expect(document.body.textContent).toContain('Temperature 0');
    });
  });

  describe('the Diff views: Chat and API logs', () => {
    const run = (id, model = 'model-a') =>
      existingRun({ id, saved_at: '2026-01-10T00:00:00Z', cursor: 2, prompts: ['first prompt', 'second prompt'], model_a: model, results: { a: [{ content: 'A0', model, demo: false, error: false }, { content: 'A1', model, demo: false, error: false }], b: [{ content: 'B0', model: 'model-b', demo: false, error: false }, { content: 'B1', model: 'model-b', demo: false, error: false }] } }); // fmt: skip
    const logGets = (mock) => mock.calls.filter((c) => c.key === 'GET /api/saved-replays/:id/api-log').map((c) => decodeURIComponent(c.path.split('/').at(-2)));
    const pick = async (id) => {
      $(`diff-view-${id}`).click();
      await settle();
    };

    it('opens on Chat and fetches no API logs until the API logs tab is chosen', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      expect($('diff-view-chat').getAttribute('aria-selected')).toBe('true');
      expect(document.querySelector('.diff-table')).not.toBeNull();
      expect(logGets(mock)).toEqual([]);
    });

    it('loads the two selected replays\' logs once and shows them side by side', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      await pick('api');
      expect($('diff-view-api').getAttribute('aria-selected')).toBe('true');
      expect(logGets(mock).sort()).toEqual(['r2:a', 'r2:b']);
      expect(document.querySelector('.diff-table')).toBeNull();
      const turns = [...document.querySelectorAll('.api-diff-turn')];
      expect(turns).toHaveLength(2);
      const pairs = [...turns[0].querySelectorAll('.api-pair')];
      expect(pairs).toHaveLength(2); // A's first call beside B's first call, then the second pair
      expect(text(pairs[0].querySelector('h4'))).toBe('#1 KB routing · Category');
      expect(document.querySelector('.api-diff details')).toBeNull(); // every call is open, none collapsed
      const lines = [...pairs[0].querySelectorAll('.diff-row:not(.diff-head)')];
      expect(lines.length).toBeGreaterThan(10);
      expect(lines.some((r) => r.classList.contains('equal'))).toBe(true);
      expect(text(lines[0].querySelector('.diff-cell.a'))).toBe('Settings'); // compared line by line, headed by sections
      expect(lines.some((r) => text(r.querySelector('.diff-cell.a')).includes('POST https://api.openai.com/v1/chat/completions'))).toBe(true);
      const changed = lines.filter((r) => r.classList.contains('changed'));
      expect(changed.map((r) => text(r.querySelector('.diff-cell.a')).trim())).toEqual(['"model": "model-a",']); // A and B ran different models
      expect(text(changed[0].querySelector('.diff-cell.b')).trim()).toBe('"model": "model-b",');
      await pick('chat');
      await pick('api');
      expect(logGets(mock)).toHaveLength(2); // switching back and forth does not fetch again
    });

    it('stays on the chosen view when the comparison is redrawn, and Chat brings the answers back', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      await pick('api');
      await openTab('replay');
      await openTab('diff');
      expect($('diff-view-api').getAttribute('aria-selected')).toBe('true');
      await pick('chat');
      expect(document.querySelectorAll('.diff-turn:not(.api-diff-turn)')).toHaveLength(2);
      expect(document.querySelector('.api-diff')).toBeNull();
    });

    it('loads the logs of a newly chosen replay when it is picked while on API logs', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      await pick('api');
      mock.calls.length = 0;
      $('diff-a').value = 'r1:a';
      $('diff-a').dispatchEvent(new Event('change'));
      await settle();
      expect(logGets(mock)).toEqual(['r1:a']); // r2:b is already loaded
      expect($('diff-view-api').getAttribute('aria-selected')).toBe('true');
    });

    it('says so, once, when a log cannot be loaded, and does not keep asking', async () => {
      const { server, mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      server.failApiLog = apiError(500, 'oops', 'The server hit a problem.');
      await pick('api');
      expect(logGets(mock)).toHaveLength(2); // one attempt each, no retry loop
      expect(document.querySelector('.api-diff-note').textContent).toContain('the API log could not be loaded');
      expect(toastText()).toContain('The server hit a problem.');
    });

    it('explains a replay saved before API logs existed, and a demo replay with no calls', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      server.apiLogMode = 'unrecorded';
      await pick('api');
      expect(document.querySelector('.api-diff').textContent).toContain('no API log was kept');
    });

    it('moves between the tabs with the arrow keys', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [run('r1'), run('r2')] });
      await openTab('diff');
      $('diff-view-chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await settle();
      expect($('diff-view-api').getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe($('diff-view-api'));
      $('diff-view-api').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await settle();
      expect($('diff-view-chat').getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('API log', () => {
    const saved = (id, extra = {}) =>
      existingRun({ id, saved_at: '2026-01-10T00:00:00Z', cursor: 2, prompts: ['first prompt', 'second prompt'], results: { a: [{ content: 'A0', model: 'model-a', demo: false, error: false }, { content: 'A1', model: 'model-a', demo: false, error: false }], b: [{ content: 'B0', model: 'model-b', demo: false, error: false }, { content: 'B1', model: 'model-b', demo: false, error: false }] }, ...extra }); // fmt: skip
    const openLog = async (id) => {
      document.querySelector(`[data-api-log="${id}"]`).click();
      await settle();
    };
    const modalEl = () => document.querySelector('.modal');

    it('opens a popup with one collapsible per REST call, grouped by prompt', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [saved('r1')] });
      await openTab('history');
      await openLog('r1:a');
      expect(mock.calls.at(-1).path).toBe('/api/saved-replays/r1%3Aa/api-log');
      expect(text(modalEl().querySelector('h2'))).toBe('API log · Replay v1 · A · model-a');
      const calls = [...modalEl().querySelectorAll('details.api-call')];
      expect(calls).toHaveLength(4); // 2 prompts x (routing + answer)
      expect(calls.every((c) => !c.open)).toBe(true);
      expect([...modalEl().querySelectorAll('.api-turn h3')].map((h) => text(h))).toEqual(['Prompt 01 2 calls', 'Prompt 02 2 calls']);
      expect(text(calls[0].querySelector('summary'))).toContain('POST');
      expect(text(calls[0].querySelector('summary'))).toContain('https://api.openai.com/v1/chat/completions');
      expect(text(calls[0].querySelector('summary'))).toContain('KB routing · Category');
      expect(text(calls[1].querySelector('summary'))).toContain('Answer');
    });

    it('shows the log for the slot that was clicked', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [saved('r1')] });
      await openTab('history');
      await openLog('r1:b');
      expect(text(modalEl().querySelector('h2'))).toBe('API log · Replay v1 · B · model-b');
      expect(modalEl().querySelector('.api-pre:nth-of-type(3)')).not.toBeNull();
      expect(modalEl().textContent).toContain('"model": "model-b"');
    });

    it('says why there is nothing to show: demo mode, or saved before logs existed', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [saved('r1')] });
      await openTab('history');
      server.apiLogMode = 'demo';
      await openLog('r1:a');
      expect(modalEl().textContent).toContain('demo mode');
      expect(modalEl().querySelector('details.api-call')).toBeNull();
      modalEl().querySelector('button[type="submit"]').click();
      await settle();
      server.apiLogMode = 'unrecorded';
      await openLog('r1:a');
      expect(modalEl().textContent).toContain('saved before API logs existed');
    });

    it('works for an earlier replay too (no version in the title) and shows an error toast when it cannot load', async () => {
      const { server } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [saved('r1', { source_conversation_id: null })] });
      await openTab('history');
      await openLog('r1:a');
      expect(text(modalEl().querySelector('h2'))).toBe('API log · A · model-a');
      modalEl().querySelector('button[type="submit"]').click();
      await settle();
      server.failApiLog = apiError(500, 'oops', 'The server hit a problem.');
      await openLog('r1:a');
      expect(modalEl()).toBeNull();
      expect(toastText()).toContain('The server hit a problem.');
    });
  });

  describe('models from several APIs', () => {
    const APPS = { settings: { models: ['H100::llama', 'A100::llama', 'A100::mixtral'], connected: true, connections: [] } };

    it('offers the replay\'s models as "label · model" and keeps the label-qualified choice as the value', async () => {
      await boot({ run: existingRun({ model_a: 'H100::llama', model_b: 'A100::llama' }), appOverrides: APPS });
      openConfig();
      expect([...$('model-a').options].map((o) => o.textContent)).toEqual(['H100 · llama', 'A100 · llama', 'A100 · mixtral']);
      expect([...$('model-a').options].map((o) => o.value)).toEqual(['H100::llama', 'A100::llama', 'A100::mixtral']);
      expect($('model-a').value).toBe('H100::llama');
      expect($('model-b').value).toBe('A100::llama');
    });

    it('sends the chosen API\'s model when a slot is changed', async () => {
      const { mock } = await boot({ run: existingRun({ model_a: 'H100::llama', model_b: 'A100::llama' }), appOverrides: APPS });
      openConfig();
      $('model-b').value = 'A100::mixtral';
      $('model-b').dispatchEvent(new Event('change'));
      await settle();
      expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ model_a: 'H100::llama', model_b: 'A100::mixtral' });
    });

    it('names each slot by its API in the result tabs, so the same model on two APIs can be told apart', async () => {
      await boot({ run: existingRun({ model_a: 'H100::llama', model_b: 'A100::llama' }), appOverrides: APPS });
      await click('step-replay');
      expect([...document.querySelectorAll('.result-tabs button')].map(text)).toEqual(['A · H100 · llama', 'B · A100 · llama']);
    });
  });

  describe('each chat has its own replays, numbered from 1, and its own Diff', () => {
    const done = (id, chat, extra = {}) =>
      existingRun({ id, saved_at: '2026-01-10T00:00:00Z', source_conversation_id: chat, cursor: 2, prompts: ['first prompt', 'second prompt'], results: { a: [{ content: `${id} A0`, model: 'model-a', demo: true, error: false }, { content: `${id} A1`, model: 'model-a', demo: true, error: false }], b: [{ content: `${id} B0`, model: 'model-b', demo: true, error: false }, { content: `${id} B1`, model: 'model-b', demo: true, error: false }] }, ...extra }); // fmt: skip
    const earlierChat = () => ({
      conversation_id: 'c9', is_sample: false, name: 'Earlier chat', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', kb_summary_tool: false,
      source_conversation_id: null, created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-02T00:00:00Z', prompt_count: 2, messages: chatMessages('older one', 'older two'),
    }); // fmt: skip
    const world = () => ({
      run: existingRun({ id: 'cur' }),
      otherChats: [earlierChat()],
      savedRuns: [done('a1', 'c1'), done('b1', 'c9'), done('a2', 'c1'), done('b2', 'c9'), done('b3', 'c9')],
    });
    const open = async (id) => {
      $('file-menu-btn').click();
      $('file-open').click();
      await settle();
      document.querySelector(`.modal input[value="${id}"]`).click();
      document.querySelector('.modal button[type="submit"]').click(); // step 1: Select
      await settle();
      document.querySelector('.modal button[type="submit"]').click(); // step 2: Open, with the chat's settings
      await settle();
    };
    const pickerLabels = (side = 'diff-a') => [...$(side).options].map((o) => o.textContent.split(' · ').slice(0, 2).join(' '));
    const pickerValues = (side = 'diff-a') => [...$(side).options].map((o) => o.value);

    it('compares only the replays of the chat on screen, numbered from 1', async () => {
      await boot(world());
      await openTab('diff');
      expect(pickerValues()).toEqual(['a2:b', 'a2:a', 'a1:b', 'a1:a']); // chat c1 only; the three of chat c9 are not here
      expect(pickerLabels()).toEqual(['Replay v2 B', 'Replay v2 A', 'Replay v1 B', 'Replay v1 A']);
    });

    it('switches to the opened chat\'s own replays, which start again at 1', async () => {
      await boot(world());
      await open('c9');
      await openTab('diff');
      expect(pickerValues()).toEqual(['b3:b', 'b3:a', 'b2:b', 'b2:a', 'b1:b', 'b1:a']);
      expect(pickerLabels()).toEqual(['Replay v3 B', 'Replay v3 A', 'Replay v2 B', 'Replay v2 A', 'Replay v1 B', 'Replay v1 A']);
      expect($('diff-a').value).not.toMatch(/^a/); // nothing from the other chat is selected
      expect($('diff-b').value).not.toMatch(/^a/);
    });

    it('goes back to the first chat\'s replays when it is opened again', async () => {
      await boot(world());
      await open('c9');
      await open('c1');
      await openTab('diff');
      expect(pickerValues()).toEqual(['a2:b', 'a2:a', 'a1:b', 'a1:a']);
    });

    it('loads and shows only the compared replays\' answers', async () => {
      const { mock } = await boot(world());
      await open('c9');
      await openTab('diff');
      const loaded = mock.calls.filter((c) => c.key === 'GET /api/saved-replays/:id').map((c) => decodeURIComponent(c.path.split('/').pop()));
      expect(loaded.every((id) => id.startsWith('b'))).toBe(true); // never a replay of the other chat
      expect(loaded.length).toBeGreaterThan(0);
    });

    it('compares from the history list within the chat: Diff on a version opens that chat\'s Diff', async () => {
      await boot(world());
      await open('c9');
      await openTab('history');
      document.querySelector('[data-compare-record="b1:a"]').click();
      await settle();
      expect($('tab-diff').getAttribute('aria-selected')).toBe('true');
      expect($('diff-a').value).toBe('b1:a');
      expect($('diff-b').value).toMatch(/^b/); // its partner is another replay of the same chat
      expect($('diff-b').value).not.toBe('b1:a');
    });

    it('says a chat with fewer than two replays has nothing to compare yet, though other chats have some', async () => {
      const onlyA = done('a1', 'c1', { results: { a: [{ content: 'A0', model: 'model-a', demo: true, error: false }], b: [] } }); // one result: nothing to compare it with
      await boot({ run: existingRun({ id: 'cur' }), otherChats: [earlierChat()], savedRuns: [onlyA, done('b1', 'c9'), done('b2', 'c9')] });
      await openTab('diff');
      expect(document.body.textContent).toContain('Two replays make a comparison');
      expect($('diff-a')).toBeNull();
      await openTab('history');
      expect(document.querySelector('[data-compare-record="a1:a"]').disabled).toBe(true);
      await open('c9');
      await openTab('diff');
      expect($('diff-a')).not.toBeNull(); // chat c9 has two
    });

    it('slides the Select Replays panel into the left edge and back, keeping the choice', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [done('a1', 'c1'), done('a2', 'c1')] });
      await openTab('diff');
      const layout = () => $('diff-layout');
      expect(layout().classList.contains('prompts-hidden')).toBe(false);
      await click('hide-selectors');
      expect(layout().classList.contains('prompts-hidden')).toBe(true);
      expect($('show-selectors').classList.contains('visible')).toBe(true);
      expect(text($('show-selectors'))).toContain('Select Replays');
      await openTab('replay');
      await openTab('diff');
      expect(layout().classList.contains('prompts-hidden')).toBe(true); // stays as the user left it
      await click('show-selectors');
      expect(layout().classList.contains('prompts-hidden')).toBe(false);
      expect($('diff-a')).not.toBeNull();
    });

    it('numbers the run on the Replay tab within its chat: the next version, then its own', async () => {
      const { mock } = await boot(world());
      await click('step-replay');
      expect(text($('replay-number'))).toBe('Replay v3'); // c1 has two saved: this run will be v3
      await open('c9');
      await openTab('replay');
      await click('step-replay');
      expect(text($('replay-number'))).toBe('Replay v4'); // c9 has three
      await click('step-replay');
      await settle(10);
      expect(text($('replay-number'))).toBe('Replay v4'); // finished and saved: that is its number
      await click('reset-replay');
      await click('step-replay');
      expect(text($('replay-number'))).toBe('Replay v5'); // the next run of the same chat
    });

    it('starts a chat that has never been replayed at v1', async () => {
      await boot({ run: existingRun({ id: 'cur' }), otherChats: [earlierChat()], savedRuns: [done('a1', 'c1')] });
      await click('step-replay');
      expect(text($('replay-number'))).toBe('Replay v2');
      await open('c9');
      await openTab('replay');
      await click('step-replay');
      expect(text($('replay-number'))).toBe('Replay v1');
    });

    it('lists replays that are not tied to a chat as earlier ones that cannot be compared', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [done('old', null), done('a1', 'c1'), done('a2', 'c1')] });
      await openTab('history');
      expect(document.querySelector('[data-compare-record="old:a"]').disabled).toBe(true);
      await openTab('diff');
      expect(pickerValues()).toEqual(['a2:b', 'a2:a', 'a1:b', 'a1:a']); // the earlier one is not offered
    });
  });

  describe('the intro popup', () => {
    it('opens with the page and says what the page is for, in the words that used to head it', async () => {
      await boot({ run: existingRun(), keepIntro: true });
      const modal = document.querySelector('.replay-intro-modal');
      expect(modal).not.toBeNull();
      expect(modal.getAttribute('role')).toBe('dialog');
      expect(text(modal.querySelector('h2'))).toBe('Model & hardware comparison');
      expect(text(modal.querySelector('.modal-lead'))).toBe('Same conversation. Different results.');
      expect(text(modal.querySelector('.modal-text'))).toBe('Replay your prompts on other models, then compare how the output differs.');
      expect(text(modal.querySelector('button[type="submit"]'))).toBe('Got it');
      expect(modal.querySelector('.modal-actions .btn:not(.yellow)')).toBeNull(); // one button, no Cancel
    });

    it('is gone from the page itself: no heading, no subtitle, but the status badge stays', async () => {
      await boot({ run: existingRun() });
      expect(document.querySelector('.page-heading h1')).toBeNull();
      expect(document.querySelector('.eyebrow + h1')).toBeNull();
      expect(document.body.textContent.match(/Same conversation\. Different results\./g)).toBeNull();
      expect(document.body.textContent).not.toContain('then compare how the output differs');
      expect(document.querySelector('.replay-status-row .badge')).not.toBeNull(); // Demo / Replay in progress
    });

    it('closes with its button, Escape or a click outside, and leaves the page usable', async () => {
      await boot({ run: existingRun(), keepIntro: true });
      document.querySelector('.replay-intro-modal button[type="submit"]').click();
      await settle();
      expect(document.querySelector('.modal')).toBeNull();
      $('file-menu-btn').click(); // the page works behind it
      expect($('file-menu').hidden).toBe(false);
      await boot({ run: existingRun(), keepIntro: true });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(document.querySelector('.modal')).toBeNull();
      await boot({ run: existingRun(), keepIntro: true });
      document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(document.querySelector('.modal')).toBeNull();
    });

    it('opens again each time the page opens, but not when the page redraws', async () => {
      await boot({ run: existingRun(), keepIntro: true });
      expect(document.querySelectorAll('.replay-intro-modal')).toHaveLength(1);
      document.querySelector('.replay-intro-modal button[type="submit"]').click();
      await settle();
      await openTab('history');
      await openTab('replay');
      await click('step-replay');
      expect(document.querySelector('.replay-intro-modal')).toBeNull(); // changing tabs or stepping does not bring it back
      await boot({ run: existingRun(), keepIntro: true });
      expect(document.querySelector('.replay-intro-modal')).not.toBeNull(); // a new visit does
    });

    it('does not stop the other popups: File > Open replaces it', async () => {
      await boot({ run: existingRun(), keepIntro: true });
      $('file-menu-btn').click();
      $('file-open').click();
      await settle();
      expect(document.querySelector('.replay-intro-modal')).toBeNull();
      expect(text(document.querySelector('.modal h2'))).toBe('Open a chat');
    });

    it('focuses its button so Enter closes it', async () => {
      await boot({ run: existingRun(), keepIntro: true });
      expect(document.activeElement).toBe(document.querySelector('.replay-intro-modal button[type="submit"]'));
    });
  });

  describe('the File menu', () => {
    it('has Open and Config but no New, which this page does not use', async () => {
      await boot({ run: existingRun() });
      $('file-menu-btn').click();
      expect([...document.querySelectorAll('#file-menu .file-menu-item')].map(text)).toEqual(['Open', 'Config']);
      expect($('file-new')).toBeNull();
    });

    it('still opens a chat and the Config popup from it', async () => {
      await boot({ run: existingRun() });
      $('file-menu-btn').click();
      $('file-config').click();
      await settle();
      expect(text(document.querySelector('.modal h2'))).toBe('Config');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      $('file-menu-btn').click();
      $('file-open').click();
      await settle();
      expect(text(document.querySelector('.modal h2'))).toBe('Open a chat');
    });
  });

  describe('chat history', () => {
    const savedReplay = (id, extra = {}) =>
      existingRun({ id, saved_at: '2026-01-10T00:00:00Z', cursor: 3, results: { a: [{ content: 'A', model: 'model-a', demo: true, error: false }], b: [{ content: 'B', model: 'model-b', demo: true, error: false }] }, ...extra }); // fmt: skip
    const earlier = (extra = {}) => ({
      conversation_id: 'c9', is_sample: false, name: 'Earlier chat', agent_id: 'research', model: 'model-b', reasoning_level: 'high',
      kb_summary_tool: true, source_conversation_id: null, created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-02T00:00:00Z', prompt_count: 2,
      messages: chatMessages('older one', 'older two'), ...extra,
    }); // fmt: skip
    const openChat = async () => {
      $('file-menu-btn').click();
      $('file-open').click();
      await settle();
    };
    const modalEl = () => document.querySelector('.modal');
    const chooseChat = async (id) => {
      modalEl().querySelector(`input[value="${id}"]`).click();
      modalEl().querySelector('button[type="submit"]').click(); // step 1: Select
      await settle();
      modalEl().querySelector('button[type="submit"]').click(); // step 2: Open, with the chat's settings
      await settle();
    };

    it('is called History and has no chat heading or transcript box', async () => {
      await boot({ run: existingRun() });
      expect(text($('tab-history'))).toBe('History');
      expect($('tab-records')).toBeNull();
      await openTab('history');
      expect(document.querySelector('.history-details')).toBeNull();
      expect($('replay-current')).toBeNull();
    });

    it('File > Open lists the chats and loads the chosen one: its history, prompts, settings and a ready replay', async () => {
      const { mock } = await boot({ run: existingRun(), otherChats: [earlier()] });
      await openChat();
      expect(modalEl().querySelector('h2').textContent).toBe('Open a chat');
      expect([...document.querySelectorAll('.chat-option')].map((o) => text(o.querySelector('.chat-option-name')))).toEqual(['Sample conversation Open now', 'Earlier chat']);
      await chooseChat('c9');
      expect(modalEl()).toBeNull();
      expect(mock.called('POST /api/conversations/:id/open')).toBe(true);
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({
        conversation_id: 'c9', agent_id: 'research', reasoning_level: 'high', kb_summary_tool: true, brief_replies: false, logprobs: false,
        temperature: 0, model_a: 'model-b', model_b: 'model-b', // the chat's own settings, taken from step 2
      }); // fmt: skip
      expect($('tab-history').getAttribute('aria-selected')).toBe('true'); // the history of the opened chat is on screen
      await openTab('replay');
      expect([...document.querySelectorAll('.prompt-row p')].map(text)).toEqual(['older one', 'older two']);
      openConfig();
      expect(text(document.querySelector('.source-chat'))).toContain('Earlier chat'); // Config shows that chat's settings
      expect(document.querySelector('.source-chat').textContent).toContain('High');
    });

    it('choosing the chat that is already shown still loads its prompts into a fresh run', async () => {
      const { mock } = await boot({ run: existingRun() });
      await openChat();
      expect(modalEl().querySelector('input[name="chat"]:checked').value).toBe('c1');
      modalEl().querySelector('button[type="submit"]').click();
      await settle();
      modalEl().querySelector('button[type="submit"]').click();
      await settle();
      expect(modalEl()).toBeNull();
      expect(mock.lastBody('POST /api/replay-runs')).toEqual({
        conversation_id: 'c1', agent_id: 'assistant', reasoning_level: 'default', kb_summary_tool: false, brief_replies: false, logprobs: false,
        temperature: 0, model_a: 'model-a', model_b: 'model-b',
      }); // fmt: skip
      expect($('tab-history').getAttribute('aria-selected')).toBe('true');
    });

    it('lists only chats, never replays, and says so', async () => {
      await boot({ run: existingRun(), savedRuns: [savedReplay('r1')] });
      await openChat();
      expect(document.querySelectorAll('.chat-option')).toHaveLength(1);
      expect(modalEl().textContent).toContain('Replays are not listed here');
    });

    it("shows a chat's saved replays as numbered versions and keeps other chats' out", async () => {
      const { mock } = await boot({
        run: existingRun({ id: 'cur' }), otherChats: [earlier()],
        savedRuns: [savedReplay('r1'), savedReplay('r2'), savedReplay('x1', { source_conversation_id: 'c9' })],
      });
      await openTab('history');
      expect([...document.querySelectorAll('.version-head h3')].map(text)).toEqual(['Replay v2', 'Replay v1']);
      expect(document.querySelector('[data-compare-record="x1:a"]')).toBeNull();
      await openChat();
      await chooseChat('c9');
      expect([...document.querySelectorAll('.version-head h3')].map(text)).toEqual(['Replay v1']);
      expect(document.querySelector('[data-compare-record="x1:a"]')).not.toBeNull();
      expect(mock.called('POST /api/conversations/:id/open')).toBe(true);
    });

    it('keeps the current chat on screen and says why when a chat cannot be opened', async () => {
      const { server } = await boot({ run: existingRun(), otherChats: [earlier()] });
      await openChat();
      server.otherChats = [];
      await chooseChat('c9');
      expect(modalEl().querySelector('.modal-error').textContent).toBe('Conversation not found.');
      expect(modalEl().querySelector('#replay-agent')).not.toBeNull(); // still on step 2, so the user can go back or retry
    });

    describe('the two steps of File > Open', () => {
      const step1 = async (id = 'c9') => {
        modalEl().querySelector(`input[value="${id}"]`).click();
        modalEl().querySelector('button[type="submit"]').click();
        await settle();
      };

      it('step 1 chooses a chat and its button says Select; nothing is opened yet', async () => {
        const { mock } = await boot({ run: existingRun(), otherChats: [earlier()] });
        await openChat();
        expect(text(modalEl().querySelector('.modal-step'))).toBe('Step 1 of 2');
        expect(text(modalEl().querySelector('button[type="submit"]'))).toBe('Select');
        expect(modalEl().querySelector('#replay-agent')).toBeNull();
        modalEl().querySelector('button[type="submit"]').click(); // nothing picked: c1 is already checked, so this goes on
        await settle();
        expect(text(modalEl().querySelector('.modal-step'))).toBe('Step 2 of 2');
        expect(mock.called('POST /api/conversations/:id/open')).toBe(false);
      });

      it("step 2 is the Config view, filled from the selected chat's settings, and its button says Open", async () => {
        const { mock } = await boot({ run: existingRun(), otherChats: [earlier()] });
        await openChat();
        await step1('c9');
        expect(text(modalEl().querySelector('.modal-step'))).toBe('Step 2 of 2');
        expect(text(modalEl().querySelector('button[type="submit"]'))).toBe('Open');
        expect(modalEl().querySelector('#chat-list, input[name="chat"]')).toBeNull(); // the list has gone
        expect(modalEl().querySelector('#replay-agent').value).toBe('research');
        expect(modalEl().querySelector('#replay-reasoning').value).toBe('high');
        expect(modalEl().querySelector('#replay-kb-summary').checked).toBe(true);
        expect(modalEl().querySelector('#replay-temperature').value).toBe('0');
        expect(modalEl().querySelector('#model-a').value).toBe('model-b'); // the chat's model
        expect(text(modalEl().querySelector('.source-chat'))).toContain('Earlier chat');
        expect(modalEl().querySelector('#open-config-step')).not.toBeNull();
        expect(modalEl().querySelector('#replay-config')).toBeNull(); // not the live Config popup's id
        expect(mock.called('POST /api/replay-runs')).toBe(false); // nothing starts until Open
      });

      it("marks the chat's own settings in green, and only while a control still has the chat's value", async () => {
        await boot({ run: existingRun(), otherChats: [earlier()] });
        await openChat();
        await step1('c9');
        const badges = [...modalEl().querySelectorAll('.chat-value')].map(text);
        expect(badges).toEqual(['Source Chat: IT Security Assistant', 'Source Chat: High', 'Source Chat: 0', 'Source Chat: On', 'Source Chat: Off', 'Source Chat: model-b']);
        const marked = () => [...modalEl().querySelectorAll('.matches-chat')].map((e) => e.id);
        expect(marked()).toEqual(['replay-agent', 'replay-reasoning', 'replay-temperature', 'replay-kb-summary', 'replay-brief', 'model-a']);
        modalEl().querySelector('#replay-reasoning').value = 'low';
        modalEl().querySelector('#replay-reasoning').dispatchEvent(new Event('change'));
        modalEl().querySelector('#replay-brief').checked = true;
        modalEl().querySelector('#replay-brief').dispatchEvent(new Event('change'));
        expect(marked()).not.toContain('replay-reasoning');
        expect(marked()).not.toContain('replay-brief');
        modalEl().querySelector('#replay-reasoning').value = 'high';
        modalEl().querySelector('#replay-reasoning').dispatchEvent(new Event('change'));
        expect(marked()).toContain('replay-reasoning'); // back to the chat's value: green again
        expect(modalEl().querySelector('#replay-logprobs').classList.contains('matches-chat')).toBe(false); // a chat has no such setting
      });

      it('Open starts the replay with whatever step 2 was changed to', async () => {
        const { mock } = await boot({ run: existingRun(), otherChats: [earlier()] });
        await openChat();
        await step1('c9');
        const set = (id, value) => {
          modalEl().querySelector(id).value = value;
        };
        set('#replay-reasoning', 'low');
        set('#replay-temperature', '0.8');
        modalEl().querySelector('#replay-brief').checked = true;
        modalEl().querySelector('#replay-logprobs').checked = true;
        set('#model-b', 'model-c');
        modalEl().querySelector('button[type="submit"]').click();
        await settle();
        expect(modalEl()).toBeNull();
        expect(mock.lastBody('POST /api/replay-runs')).toEqual({
          conversation_id: 'c9', agent_id: 'research', reasoning_level: 'low', kb_summary_tool: true, brief_replies: true, logprobs: true,
          temperature: 0.8, model_a: 'model-b', model_b: 'model-c',
        }); // fmt: skip
        expect($('tab-history').getAttribute('aria-selected')).toBe('true');
      });

      it('Back returns to the list with the chat still selected, and a bad temperature stays on step 2', async () => {
        await boot({ run: existingRun(), otherChats: [earlier()] });
        await openChat();
        await step1('c9');
        modalEl().querySelector('#replay-temperature').value = '9';
        modalEl().querySelector('button[type="submit"]').click();
        await settle();
        expect(modalEl().querySelector('.modal-error').textContent).toBe('Temperature must be a number from 0 to 2.');
        modalEl().querySelector('[data-picker-back]').click();
        expect(text(modalEl().querySelector('.modal-step'))).toBe('Step 1 of 2');
        expect(text(modalEl().querySelector('button[type="submit"]'))).toBe('Select');
        expect(modalEl().querySelector('input[name="chat"]:checked').value).toBe('c9');
        expect(modalEl().querySelector('[data-picker-back]')).toBeNull();
      });
    });

    it('does nothing while a replay is running', async () => {
      const { server, mock } = await boot({ run: existingRun(), otherChats: [earlier()] });
      server.hold = true;
      $('step-replay').click();
      await settle();
      await openChat();
      expect(modalEl()).toBeNull();
      expect(mock.called('GET /api/conversations')).toBe(false);
      server.release();
    });
  });

  describe('diff', () => {
    const trace = [{ step: 'category', options: [{ id: 'c1', name: 'Networks' }], chosen: { id: 'c1', name: 'Networks' }, model: 'model-a', reason: null, at: '2026-01-01T00:00:00Z' }];
    const answers = (model, texts, withTrace) => texts.map((content) => ({ content, model, demo: true, error: false, decision_trace: withTrace ? trace : null })); // fmt: skip
    const savedRun = (id, a, b, withTrace = false) =>
      existingRun({ id, saved_at: '2026-01-10T00:00:00Z', prompts: ['first prompt', 'second prompt'], cursor: 2, results: { a: answers('model-a', a, withTrace), b: answers('model-b', b) } }); // fmt: skip
    const detailGets = (mock) => mock.calls.filter((c) => c.key === 'GET /api/saved-replays/:id').map((c) => decodeURIComponent(c.path.split('/').pop()));

    it('loads the two selected saved replays only when the Diff tab is opened', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO']), savedRun('r2', ['one', 'changed'], ['ONE', 'TWO'])] });
      expect(detailGets(mock)).toEqual([]);
      await openTab('diff');
      expect(detailGets(mock).sort()).toEqual(['r2:a', 'r2:b']); // the two most recent saved replays
      expect(document.querySelectorAll('.diff-turn')).toHaveLength(2);
      expect(text(document.querySelector('.diff-summary .badge'))).toBe('2 changed turns');
      expect($('diff-a').value).toBe('r2:a');
      expect($('diff-b').value).toBe('r2:b');
    });

    it('says two replays are needed when fewer than two are saved', async () => {
      await boot({ run: existingRun() });
      await openTab('diff');
      expect(document.body.textContent).toContain('Two replays make a comparison');
    });

    it('opens a comparison from the saved replays list', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO']), savedRun('r2', ['one', 'two'], ['one', 'two'])] });
      await openTab('history');
      document.querySelector('[data-compare-record="r1:a"]').click();
      await settle();
      expect($('tab-diff').getAttribute('aria-selected')).toBe('true');
      expect($('diff-a').value).toBe('r1:a');
      expect($('diff-b').value).toBe('r2:b');
      expect(detailGets(mock).sort()).toEqual(['r1:a', 'r2:b']);
    });

    it('shows both responses\' decision trees side by side in one collapsible, before the response text', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO'], true)] });
      await openTab('diff');
      const first = document.querySelector('.diff-turn');
      const trees = first.querySelectorAll('details.decision-tree');
      expect(trees).toHaveLength(1);
      expect(text(trees[0].querySelector('summary'))).toContain('A · 1 step');
      expect(text(trees[0].querySelector('summary'))).toContain('B · 0 steps'); // slot B recorded none
      const treeRows = [...trees[0].querySelectorAll('.diff-row:not(.diff-head) .diff-cell.a')].map(text);
      expect(treeRows[0]).toBe('Step 1 · Category');
      expect(treeRows).toContain('  Chosen: Networks');
      expect(trees[0].querySelector('.diff-row:not(.diff-head) .diff-cell.b').classList.contains('gap')).toBe(true);
      expect(trees[0].open).toBe(false);
    });

    it('fetches a newly chosen replay once and reuses it after that', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO']), savedRun('r2', ['x', 'y'], ['X', 'Y'])] });
      await openTab('diff');
      mock.calls.length = 0;
      $('diff-a').value = 'r1:a';
      $('diff-a').dispatchEvent(new Event('change'));
      await settle();
      expect(detailGets(mock)).toEqual(['r1:a']);
      $('diff-a').value = 'r2:a';
      $('diff-a').dispatchEvent(new Event('change'));
      await settle();
      expect(detailGets(mock)).toEqual(['r1:a']); // r2:a was already loaded
    });

    it('follows the newest saved replays until the user picks a pair', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO'])] });
      await openTab('replay');
      await click('play-replay'); // the current run finishes and is saved: two newer saved replays
      await settle(10);
      await openTab('diff');
      const labels = [...$('diff-a').options].map((o) => o.value);
      expect(labels).toHaveLength(4);
      expect([$('diff-a').value, $('diff-b').value]).toEqual(['cur:a', 'cur:b']); // the newest pair, not the one from page load
      expect(detailGets(mock).sort()).toEqual(['cur:a', 'cur:b']);
    });

    it('moves the selection to the replay that just finished, even when the user had picked another pair', async () => {
      await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO']), savedRun('r2', ['x', 'y'], ['X', 'Y'])] });
      await openTab('diff');
      $('diff-a').value = 'r1:a';
      $('diff-a').dispatchEvent(new Event('change'));
      await settle();
      await openTab('replay');
      await click('play-replay'); // a new replay finishes and is saved
      await settle(10);
      await openTab('diff');
      expect([$('diff-a').value, $('diff-b').value]).toEqual(['cur:a', 'cur:b']); // the replay that just ran, not the earlier choice
      $('diff-a').value = 'r1:a'; // and the user can still choose again
      $('diff-a').dispatchEvent(new Event('change'));
      await settle();
      expect($('diff-a').value).toBe('r1:a');
    });

    it('drops cached details when the run changes, so a continued run is never shown stale', async () => {
      const { mock } = await boot({ run: existingRun({ id: 'cur' }), savedRuns: [savedRun('r1', ['one', 'two'], ['ONE', 'TWO']), savedRun('r2', ['x', 'y'], ['X', 'Y'])] });
      await openTab('diff');
      await openTab('replay');
      await click('step-replay'); // the current run advances
      mock.calls.length = 0;
      await openTab('diff');
      expect(detailGets(mock).sort()).toEqual(['r2:a', 'r2:b']);
    });
  });
});

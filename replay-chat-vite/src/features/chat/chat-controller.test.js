import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '../../shared/http.js';
import { apiError, appRoutes, created, mockApi, noContent, settle } from '../../test/mock-api.js';

const $ = (id) => document.getElementById(id);
const ID = /^[A-Za-z0-9_-]{8,64}$/; // a request id the backend accepts

const msg = (n, role, content, extra = {}) => ({
  message_id: `m${n}`, role, content, status: 'complete', model: null, agent: null, demo: false, ...extra,
}); // fmt: skip

const sample = () => [
  msg(1, 'user', 'Help me plan a simple website for my new project.'),
  msg(2, 'assistant', 'Absolutely. Let us define three things.', { demo: true, agent: 'General assistant' }),
  msg(3, 'user', 'It is a creative workspace for small teams.'),
  msg(4, 'assistant', 'Then keep it focused.', { demo: true, agent: 'General assistant' }),
  msg(5, 'user', 'Can you turn that into a short project brief?'),
  msg(6, 'assistant', 'Project brief: A calmer place to create.', { demo: true, agent: 'General assistant' }),
];

/** An in-memory fake of the conversation routes. `server.hold` makes sends wait for `server.release()`. */
function chatServer({ appOverrides = {}, messages = sample(), isSample = true, failSend = null, config = {}, otherChats } = {}) {
  const { state: app, routes } = appRoutes(appOverrides);
  const server = {
    app,
    conversation: {
      conversation_id: 'c1', is_sample: isSample, name: 'Sample conversation', agent_id: 'assistant', model: 'model-a',
      reasoning_level: 'default', kb_summary_tool: false, source_conversation_id: null, created_at: '2026-01-01T00:00:00Z', max_user_prompts: 10, messages,
      locked: false, lock_reason: null, forked_from_conversation_id: null, forked_from_name: null,
      ...config,
    }, // fmt: skip
    hold: false,
    otherChats,
    forks: 0,
    failRefresh: false,
    order: [],
    release: () => {},
  };
  let next = 100;
  const send = async ({ body, params, signal }) => {
    server.order.push('send');
    if (server.conversation.locked) return apiError(409, 'conversation_locked', 'This conversation is locked. Open it to fork it and keep going from a copy.');
    const user = msg(next++, 'user', body.content, { status: 'pending', request_id: body.request_id });
    server.conversation.messages.push(user);
    server.conversation.is_sample = false;
    if (server.hold) {
      await new Promise((resolve) => {
        server.release = resolve;
        signal?.addEventListener('abort', resolve);
      });
      if (server.forgetOnAbort && signal?.aborted) {
        // the aborted request has not been stored yet when the page reloads
        server.conversation.messages = server.conversation.messages.filter((m) => m !== user);
        throw new DOMException('Aborted', 'AbortError');
      }
      if (server.completeOnAbort && signal?.aborted) {
        // the reply beat the stop command
        user.status = 'complete';
        server.conversation.messages.push(msg(next++, 'assistant', `reply to: ${body.content}`, { model: server.conversation.model }));
        throw new DOMException('Aborted', 'AbortError');
      }
      if (user.status === 'stopped' || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    if (failSend) {
      user.status = 'failed';
      return failSend;
    }
    user.status = 'complete';
    const reply = server.nextReply ?? msg(next++, 'assistant', `reply to: ${body.content}`, { model: server.conversation.model, agent: 'General assistant' });
    server.conversation.messages.push(reply);
    return { messages: [{ ...user }, reply] };
  };
  const mock = mockApi({
    ...routes,
    'GET /api/conversations/:id/api-log': ({ params }) =>
      server.apiLog === 'missing'
        ? apiError(404, 'not_found', 'Conversation not found.')
        : (server.apiLog ?? {
            id: params.id, recorded: true, model: 'model-a', temperature: 0, reasoning_level: 'default', logprobs: false,
            turns: [{ turn_index: 0, prompt: 'first prompt', calls: [{
              at: '2026-01-01T00:00:00Z', purpose: 'answer', method: 'POST', url: 'https://api.example.com/v1/chat/completions', duration_ms: 30,
              request: { headers: { Authorization: 'Bearer <redacted>' }, body: { model: 'model-a', messages: [{ role: 'user', content: 'first prompt\n\nRespond in 100 words or less.' }] } },
              response: { status: 200, body: '{}', truncated: false }, error: null,
            }] }],
          }), // fmt: skip
    'GET /api/conversations/current': () => {
      server.order.push('refresh');
      if (server.failRefresh) return apiError(500, 'oops', 'The server hit a problem.');
      return structuredClone(server.conversation);
    },
    'POST /api/conversations/:id/messages': send,
    'POST /api/conversations/:id/stop': () => {
      server.order.push('stop');
      const last = [...server.conversation.messages].reverse().find((m) => m.role === 'user');
      const pending = last?.status === 'pending';
      if (pending) last.status = 'stopped';
      return { stopped: pending };
    },
    'PUT /api/preferences': ({ body }) => server.failPrefs ?? Object.assign(app.preferences, body),
    'DELETE /api/conversations/:id': ({ params }) => {
      if (server.failDelete) return server.failDelete;
      server.deleted = [...(server.deleted ?? []), params.id];
      return noContent();
    },
    'POST /api/conversations/:id/lock': () => {
      if (server.failLock) return server.failLock;
      server.conversation.locked = true;
      server.conversation.lock_reason ??= 'user';
      return structuredClone(server.conversation);
    },
    'POST /api/conversations/:id/fork': ({ params, body }) => {
      if (server.failFork) return server.failFork;
      const source = server.conversation.conversation_id === params.id ? server.conversation : (server.otherChats ?? []).find((o) => o.conversation_id === params.id);
      let kept = structuredClone(source.messages ?? []);
      if (body?.through_message_id) {
        const at = kept.findIndex((m) => m.message_id === body.through_message_id);
        if (at < 0) return apiError(404, 'not_found', 'Message not found.');
        kept = kept.slice(0, at + 1);
      }
      server.conversation = {
        ...structuredClone(source), conversation_id: `fork-${++server.forks}`, is_sample: false, name: `${source.name} (fork)`,
        locked: false, lock_reason: null, forked_from_conversation_id: source.conversation_id, forked_from_name: source.name,
        messages: kept.map((m, n) => ({ ...m, message_id: `f${server.forks}-${n}` })),
      }; // fmt: skip
      return created(structuredClone(server.conversation));
    },
    'GET /api/conversations': () => {
      if (server.failList) return server.failList;
      const c = server.conversation;
      const own = { ...c, prompt_count: c.messages.filter((m) => m.role === 'user').length, updated_at: '2026-01-03T00:00:00Z' };
      return structuredClone([own, ...(server.otherChats ?? []).map((o) => ({ ...o, messages: undefined }))]);
    },
    'POST /api/conversations/:id/open': ({ params }) => {
      const chat = (server.otherChats ?? []).find((o) => o.conversation_id === params.id);
      if (!chat) return apiError(404, 'not_found', 'Conversation not found.');
      server.conversation = structuredClone(chat);
      return structuredClone(server.conversation);
    },
    'POST /api/conversations': ({ body }) => {
      if (server.failCreate) return server.failCreate;
      server.conversation = {
        conversation_id: 'c2', is_sample: false, name: body.name || 'Generated name', agent_id: body.agent_id, model: body.model,
        reasoning_level: body.reasoning_level, temperature: body.temperature, kb_summary_tool: body.kb_summary_tool, source_conversation_id: null,
        created_at: '2026-01-02T00:00:00Z', max_user_prompts: 10, messages: [],
      }; // fmt: skip
      return created(structuredClone(server.conversation));
    },
    'PATCH /api/conversations/:id': ({ body }) => {
      if (Object.keys(body).some((k) => k !== 'name')) return apiError(409, 'configuration_fixed', 'A conversation\'s settings are fixed when it starts.');
      server.conversation.name = body.name.trim() || 'Generated name';
      return structuredClone(server.conversation);
    },
    'POST /api/conversations/:id/compact': () => {
      if (server.failCompact) return server.failCompact;
      const source = server.conversation;
      server.conversation = {
        ...source, conversation_id: 'c3', is_sample: false, name: `${source.name} (summary)`, source_conversation_id: source.conversation_id,
        messages: [msg(900, 'assistant', 'SUMMARY OF THE EARLIER CONVERSATION', { message_type: 'compacted_summary', model: source.model })],
      }; // fmt: skip
      return created(structuredClone(server.conversation));
    },
  });
  return { server, mock };
}

/** Load the page. The "Welcome back" popup that opens on arrival is dismissed (so the tests start from the chat on screen), unless `keepArrival`. */
async function boot({ keepArrival = false, ...options } = {}) {
  vi.resetModules();
  document.body.innerHTML = '';
  setUnauthorizedHandler(vi.fn());
  // Most tests were written when Compact was always shown, so they start with its switch on (it is off for a new user). The
  // Config tests pass their own preferences; anything given in `appOverrides.preferences` wins.
  const preferences = { agent_id: 'assistant', model: null, chat_sidebar_hidden: false, replay_prompts_hidden: true, show_compact_button: true, show_rewind_button: true, ...options.appOverrides?.preferences };
  const fake = chatServer({ ...options, appOverrides: { ...options.appOverrides, preferences } });
  await import('./chat-controller.js');
  await settle();
  if (!keepArrival) document.querySelector('[data-modal-close]')?.click();
  return fake;
}
const submit = (text) => {
  $('prompt').value = text;
  $('chat-form').requestSubmit();
};
/** File > New opens the New conversation popup. */
const newChat = () => {
  $('file-menu-btn').click();
  $('file-new').click();
};
/** File > Config opens the Config popup. */
const openConfig = () => {
  $('file-menu-btn').click();
  $('file-config').click();
};
/** File > Open opens the chat list. */
const openChat = async () => {
  $('file-menu-btn').click();
  $('file-open').click();
  await settle();
};
const text = (el) => el?.textContent ?? '';
const toastText = () => document.querySelector('.toast')?.textContent;
const messageEls = () => [...document.querySelectorAll('.message')];
const chips = () =>
  Object.fromEntries([...document.querySelectorAll('.side-settings-list li')].map((c) => [c.querySelector('b').textContent.toUpperCase(), c.childNodes[1].textContent]));
const modal = () => document.querySelector('.modal');
const field = (name) => modal().elements?.[name] ?? modal().querySelector(`[name="${name}"]`);
const messageCopies = () => [...document.querySelectorAll('.message-copy')].map((e) => e.textContent);

describe('chat page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the text added to each prompt, apart from what the user wrote, only when Brief replies is on', async () => {
    await boot({ config: { brief_replies: true, brief_instruction: 'Respond in 100 words or less.' } });
    const prompts = [...document.querySelectorAll('.message.user')];
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      const added = prompt.querySelector('.message-appended');
      expect(added.textContent).toContain('Respond in 100 words or less.');
      expect(added.textContent).toContain('sent to the model');
      expect(prompt.querySelector('.message-copy').textContent).not.toContain('Respond in 100 words'); // what the user wrote is untouched
    }
    expect(document.querySelectorAll('.message.assistant .message-appended')).toHaveLength(0);
    await boot();
    expect(document.querySelectorAll('.message-appended')).toHaveLength(0);
  });

  it('opens the API log from a button in the replay callout, showing what was sent for each prompt', async () => {
    const { mock } = await boot();
    const button = document.querySelector('.replay-callout #chat-api-log');
    expect(button.textContent).toBe('API log');
    expect(mock.called('GET /api/conversations/:id/api-log')).toBe(false); // read only when asked for
    button.click();
    await settle();
    expect(mock.calls.at(-1).path).toBe('/api/conversations/c1/api-log');
    expect(modal().querySelector('h2').textContent).toContain('API log · Sample conversation');
    expect(modal().querySelectorAll('details.api-call')).toHaveLength(1); // each REST call is its own collapsible
    expect(modal().textContent).toContain('first prompt');
    expect(modal().textContent).toContain('Respond in 100 words or less.'); // the appended text, exactly as sent
    expect(modal().textContent).toContain('Chat temperature');
  });

  it('says why there is nothing to show for a chat that started before the log existed', async () => {
    const { server } = await boot();
    server.apiLog = { id: 'c1', recorded: false, model: 'model-a', temperature: 0, reasoning_level: 'default', logprobs: false, turns: [] };
    $('chat-api-log').click();
    await settle();
    expect(modal().textContent).toContain('No API log was kept for this chat. It started before API logs existed.');
  });

  it('shows the error when the log cannot be read', async () => {
    const { server } = await boot();
    server.apiLog = 'missing';
    $('chat-api-log').click();
    await settle();
    expect(modal()).toBeNull();
    expect(toastText()).toBe('Conversation not found.');
  });

  it('has a New Chat button beside the connection badge that opens the same New conversation popup as File > New', async () => {
    await boot();
    const right = $('topbar-actions');
    expect(right.firstElementChild.classList.contains('badge')).toBe(true);
    expect(right.lastElementChild.id).toBe('new-chat');
    expect(right.lastElementChild.textContent).toBe('New Chat');
    $('new-chat').click();
    expect(modal().querySelector('h2').textContent).toBe(document.querySelector('.modal-head h2').textContent);
    expect(field('name')).not.toBeNull(); // the New conversation form
    expect(field('agent') || modal().querySelector('select')).not.toBeNull();
  });

  describe('the badge and New Chat in the top bar', () => {
    it('take the avatar\'s place at the right end of the top bar, before the menu button', async () => {
      await boot();
      const end = document.querySelector('.top-end');
      expect(document.querySelector('.avatar')).toBeNull(); // replaced on this page
      expect(end.firstElementChild).toBe($('topbar-actions'));
      expect(end.lastElementChild).toBe($('menu'));
      expect(text($('topbar-actions').querySelector('.badge'))).toContain('Demo mode');
      expect($('new-chat').closest('.topbar')).not.toBeNull();
    });

    it('leave the chat card with no header bar: the messages start at the top', async () => {
      await boot();
      const card = document.querySelector('.chat-card');
      expect(card.querySelector('.chat-toolbar')).toBeNull();
      expect(card.querySelector('.agent-icon')).toBeNull();
      expect(card.firstElementChild.id).toBe('messages');
      expect(card.lastElementChild.classList.contains('composer-area')).toBe(true);
    });

    it('are no longer in the chat card header', async () => {
      await boot();
      const card = document.querySelector('.chat-card');
      expect(card.contains($('new-chat'))).toBe(false);
      expect(card.querySelector('.badge')).toBeNull();
      expect(document.querySelector('.toolbar-right')).toBeNull();
    });

    it('say API connected when an API is connected', async () => {
      await boot({ appOverrides: { settings: { models: ['model-a', 'model-b', 'model-c'], connected: true, connections: [] } } });
      expect(text($('topbar-actions').querySelector('.badge'))).toContain('API connected');
    });

    it('are drawn once and survive redraws', async () => {
      await boot();
      $('rewind').click();
      document.querySelector('.modal-form').requestSubmit();
      $('forward').click();
      expect(document.querySelectorAll('#topbar-actions')).toHaveLength(1);
      expect(document.querySelectorAll('#new-chat')).toHaveLength(1);
      $('new-chat').click(); // still wired after the redraws
      expect(modal()).not.toBeNull();
    });

    it('show the Locked badge first on a locked chat', async () => {
      await boot({ config: { locked: true, lock_reason: 'user' } });
      expect($('topbar-actions').firstElementChild.id).toBe('lock-badge');
      expect($('topbar-actions').contains($('new-chat'))).toBe(true);
    });
  });

  it('renders the conversation, agents and models from the server', async () => {
    await boot();
    expect(document.querySelectorAll('.message')).toHaveLength(6);
    expect(document.querySelector('#conversation-sidebar .badge').textContent).toBe('3 turns');
    expect($('conversation-name').textContent).toBe('Sample conversation');
    expect(chips()).toEqual({ AGENT: 'General assistant', MODEL: 'model-a', REASONING: 'Default (model decides)', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'Off', 'BRIEF REPLIES': 'Off' });
    expect(document.querySelectorAll('.config-chips')).toHaveLength(0); // no chips any more: a bullet list
    expect(document.querySelectorAll('.side-settings-list')).toHaveLength(1);
    expect(document.querySelector('#conversation-sidebar .side-settings-list')).not.toBeNull(); // the settings sit in the sidebar
    const box = document.querySelector('details#side-settings');
    expect(box.open).toBe(false); // collapsed until the user opens it
    expect(box.querySelector('summary').textContent).toBe('Settings');
    expect([...box.querySelectorAll('ul > li')]).toHaveLength(6); // a bullet list
    expect(document.querySelector('.turn-list').closest('details')).toBeNull(); // the prompts are not inside it
    box.open = true;
    box.dispatchEvent(new Event('toggle'));
    $('prompt').value = 'one more';
    $('chat-form').requestSubmit();
    await settle();
    expect(document.querySelector('details#side-settings').open).toBe(true); // stays as left after the page redraws
    expect($('agent')).toBeNull(); // the settings are fixed: no pickers on the chat page
    expect($('chat-model')).toBeNull();
    expect(document.querySelector('.drawer-username').textContent).toBe('demo');
    expect(document.body.textContent).toContain('Saved to your account');
    expect(document.body.textContent).not.toContain('in your browser');
  });

  it('shows the knowledge-base walk above an answer that used it, and nothing on one that did not', async () => {
    const trace = [{ step: 'category', options: [{ id: 'c1', name: 'Networks' }], chosen: { id: 'c1', name: 'Networks' }, model: 'model-a', reason: 'It is about networks', outcome: 'chosen', at: '2026-01-01T00:00:00Z' }, { step: 'file', options: [{ id: 'f1', name: 'net.txt' }], chosen: { id: 'f1', name: 'net.txt' }, model: 'model-a', reason: null, outcome: 'chosen', at: '2026-01-01T00:00:01Z' }]; // fmt: skip
    await boot({
      messages: [
        msg(1, 'user', 'How do I segment my network?', { request_id: 'req-1-aaaaaa' }),
        msg(2, 'assistant', 'Segment by trust level.', { agent: 'IT Security Assistant', decision_trace: trace }),
        msg(3, 'user', 'Thanks'),
        msg(4, 'assistant', 'You are welcome.', { agent: 'IT Security Assistant', decision_trace: null }),
      ],
    });
    const articles = messageEls();
    const tree = articles[1].querySelector('.decision-tree');
    expect(tree).not.toBeNull();
    expect(tree.querySelector('summary').textContent).toContain('2 steps');
    expect(tree.open).toBe(false);
    expect(articles[1].querySelector('.message-copy').textContent).toBe('Segment by trust level.');
    const children = [...articles[1].querySelector('.message-body').children].map((e) => e.className.split(' ')[0]);
    expect(children.indexOf('decision-tree')).toBeLessThan(children.indexOf('message-copy')); // above the answer text
    expect(articles[0].querySelector('.decision-tree')).toBeNull(); // not on prompts
    expect(articles[3].querySelector('.decision-tree')).toBeNull(); // and not on an answer that used no knowledge
    expect(document.querySelectorAll('.decision-tree')).toHaveLength(1);
  });

  it('shows the walk of a reply as soon as it arrives', async () => {
    const { server } = await boot();
    const reply = msg(100, 'assistant', 'reply with knowledge', { agent: 'General assistant', decision_trace: [{ step: 'category', options: [{ id: 'c1', name: 'Networks' }], chosen: { id: 'c1', name: 'Networks' }, model: 'model-a', reason: 'It is about networks', outcome: 'chosen', at: '2026-01-01T00:00:00Z' }, { step: 'file', options: [{ id: 'f1', name: 'net.txt' }], chosen: { id: 'f1', name: 'net.txt' }, model: 'model-a', reason: null, outcome: 'chosen', at: '2026-01-01T00:00:01Z' }] }); // fmt: skip
    server.nextReply = reply;
    submit('How do I segment my network?');
    await settle();
    expect(messageEls().at(-1).querySelector('.decision-tree summary').textContent).toContain('2 steps');
  });

  it('restores the sidebar state, and starts the New conversation popup from the remembered agent and model', async () => {
    await boot({
      appOverrides: { preferences: { agent_id: 'code', model: 'model-c', chat_sidebar_hidden: true, replay_prompts_hidden: true } },
    });
    expect($('chat-layout').classList.contains('conversation-hidden')).toBe(true);
    expect(chips().AGENT).toBe('General assistant'); // the conversation keeps its own settings
    newChat();
    expect(field('agent').value).toBe('code');
    expect(field('model').value).toBe('model-c');
  });

  it('the popup falls back to the first model and agent when the remembered ones are gone', async () => {
    await boot({ appOverrides: { preferences: { agent_id: 'gone', model: 'removed', chat_sidebar_hidden: false, replay_prompts_hidden: true } } });
    newChat();
    expect(field('model').value).toBe('model-a');
    expect(field('agent').value).toBe('assistant');
  });

  it('sends a prompt: shows it at once, then the server reply', async () => {
    const { server, mock } = await boot();
    server.hold = true;
    submit('Plan my launch');
    await settle();
    expect(messageEls().at(-1).textContent).toContain('Thinking');
    expect(document.querySelector('[data-message="6"] .message-meta').textContent).toContain('Sending…');
    expect($('send').textContent).toContain('Stop');
    server.release();
    await settle();
    expect(mock.lastBody('POST /api/conversations/:id/messages')).toEqual({ content: 'Plan my launch', request_id: expect.stringMatching(ID) });
    const messages = [...document.querySelectorAll('.message-copy')].map((e) => e.textContent);
    expect(messages.slice(-2)).toEqual(['Plan my launch', 'reply to: Plan my launch']);
    expect($('send').textContent).toContain('Send message');
    expect(document.querySelector('.prompt-head-actions .badge').textContent).toBe('4 turns');
  });

  it('shows the conversation\'s own settings and sends only the text with each message', async () => {
    const { mock } = await boot({ config: { agent_id: 'research', model: 'model-b', reasoning_level: 'high', kb_summary_tool: true } });
    expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-b', REASONING: 'High', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On', 'BRIEF REPLIES': 'Off' });
    submit('hello');
    await settle();
    expect(mock.lastBody('POST /api/conversations/:id/messages')).toEqual({ content: 'hello', request_id: expect.stringMatching(ID) });
    expect(mock.called('PUT /api/preferences')).toBe(false); // nothing on this page changes the remembered agent or model
  });

  it('keeps the prompt and shows the server error when the model call fails', async () => {
    await boot({ failSend: apiError(502, 'llm_http_error', 'API returned HTTP 401. Check your key, model ID, and endpoint in Account.') });
    submit('this will fail');
    await settle();
    expect(toastText()).toBe('API returned HTTP 401. Check your key, model ID, and endpoint in Account.');
    const last = messageEls().at(-1);
    expect(last.textContent).toContain('this will fail');
    expect(last.textContent).toContain('No reply');
    expect($('send').textContent).toContain('Send message');
  });

  it('Stop tells the server first, cancels the request, then shows the saved prompt as stopped', async () => {
    const { server, mock } = await boot();
    server.hold = true;
    submit('slow one');
    await settle();
    $('send').click(); // the Stop button
    await settle();
    expect(server.order.slice(-3)).toEqual(['send', 'stop', 'refresh']); // the stop command reaches the server before the reload
    const requestId = mock.lastBody('POST /api/conversations/:id/messages').request_id;
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(mock.lastBody('POST /api/conversations/:id/stop')).toEqual({ request_id: requestId }); // the stop names the send
    expect(toastText()).toBe('Response stopped. Your prompt is saved.');
    const last = messageEls().at(-1);
    expect(last.textContent).toContain('slow one');
    expect(last.textContent).toContain('Stopped');
    expect(messageEls()).toHaveLength(7); // no reply was added
    expect($('send').textContent).toContain('Send message');
  });

  it('keeps the prompt on screen after Stop even when the server has not stored it yet', async () => {
    const { server } = await boot();
    server.hold = true;
    server.forgetOnAbort = true;
    submit('still on its way');
    await settle();
    $('send').click();
    await settle();
    const last = messageEls().at(-1);
    expect(last.textContent).toContain('still on its way');
    expect(last.textContent).toContain('Stopped');
    expect(toastText()).toBe('Response stopped.'); // it does not claim the prompt is saved: the server never got it
    expect(messageEls()).toHaveLength(7);
  });

  it('shows the reply, with no "stopped" message, when the reply beat the stop command', async () => {
    const { server } = await boot();
    server.hold = true;
    server.completeOnAbort = true;
    submit('fast model');
    await settle();
    $('send').click();
    await settle();
    expect(messageCopies().slice(-2)).toEqual(['fast model', 'reply to: fast model']);
    expect(toastText()).toBeUndefined();
  });

  it('treats a 409 stopped answer (stopped elsewhere) the same way', async () => {
    await boot({ failSend: apiError(409, 'stopped', 'Response stopped. Your prompt is saved.') });
    submit('stopped from another tab');
    await settle();
    expect(toastText()).toBe('Response stopped. Your prompt is saved.');
  });

  it('still shows the local prompt as unanswered if the reload also fails', async () => {
    const { server } = await boot({ failSend: apiError(502, 'llm_unreachable', 'Could not reach your API.') });
    server.failRefresh = true;
    submit('network went away');
    await settle();
    expect(toastText()).toBe('Could not reach your API.');
    const last = messageEls().at(-1);
    expect(last.textContent).toContain('network went away');
    expect(last.textContent).toContain('No reply');
    expect($('send').textContent).toContain('Send message');
  });

  describe('Rewind, step mode and Start fork', () => {
    const popupForm = () => document.querySelector('.modal-form');
    const popupTitle = () => document.querySelector('.modal-head h2')?.textContent;
    const confirm = async () => {
      popupForm().requestSubmit();
      await settle();
    };
    const cancel = () => document.querySelector('[data-modal-close]').click();
    const rewind = async () => {
      $('rewind').click();
      await settle();
    };
    /** Rewind asks first ("Entering rewind mode"); confirm it. This only enters the mode: the view stays at the end. */
    const enterRewindMode = async () => {
      await rewind();
      await confirm();
    };
    /** Enter rewind mode, then click Rewind once inside it: one prompt back. */
    const rewindConfirmed = async () => {
      await enterRewindMode();
      await rewind();
    };
    const shownPrompts = () => messageCopies().filter((_, i) => i % 2 === 0);

    it('says it is entering rewind mode before it starts', async () => {
      await boot();
      await rewind();
      expect(popupTitle()).toBe('Entering rewind mode');
      expect(text(modal())).toContain('Your current conversation is kept as it is.');
      expect(text(modal())).toContain('Cancel to leave rewind mode');
      expect(document.querySelector('.modal-form button[type="submit"]').textContent).toBe('Enter rewind mode');
      expect(document.querySelectorAll('.message')).toHaveLength(6); // nothing moved yet
      expect($('chat-form').dataset.step).toBe('false');
    });

    it('entering rewind mode does not step back: the view stays at the end until Rewind is clicked inside the mode', async () => {
      const { mock } = await boot();
      await enterRewindMode();
      expect($('chat-form').dataset.step).toBe('true');
      expect(document.querySelectorAll('.message')).toHaveLength(6); // nothing hidden yet
      expect(text(document.querySelector('.composer-hint'))).toBe('Rewind mode · prompt 3 of 3. Click Start fork to continue from here, or Cancel.');
      expect($('send').textContent).toContain('Start fork');
      expect($('prompt').disabled).toBe(true);
      expect($('forward').disabled).toBe(true); // already at the end
      expect($('rewind').disabled).toBe(false);
      expect($('rewind-cancel')).not.toBeNull();
      await rewind(); // now the user steps back
      expect(document.querySelectorAll('.message')).toHaveLength(4);
      expect($('forward').disabled).toBe(false);
      expect(mock.called('POST /api/conversations/:id/fork')).toBe(false);
    });

    it('Cancel leaves the view where it was', async () => {
      await boot();
      await rewind();
      cancel();
      expect(modal()).toBeNull();
      expect(document.querySelectorAll('.message')).toHaveLength(6);
      expect($('send').textContent).toContain('Send message');
    });

    it('steps back one prompt at a time, hiding what follows but deleting nothing', async () => {
      const { server, mock } = await boot();
      await rewindConfirmed();
      expect(document.querySelectorAll('.message')).toHaveLength(4);
      expect(server.conversation.messages).toHaveLength(6); // the conversation itself is unchanged
      expect(mock.calls.some((c) => c.path.endsWith('/rewind'))).toBe(false); // no server call: it only moves the view
      await rewind(); // the popup is only for the first step back
      expect(modal()).toBeNull();
      expect(document.querySelectorAll('.message')).toHaveLength(2);
    });

    it('never goes below one prompt', async () => {
      await boot();
      await rewindConfirmed();
      await rewind();
      expect($('rewind').disabled).toBe(true);
      expect(text(document.querySelector('.composer-hint'))).toBe('Rewind mode · prompt 1 of 3. Click Start fork to continue from here, or Cancel.');
    });

    it('in step mode the textarea is disabled and Send says Start fork', async () => {
      await boot();
      await rewindConfirmed();
      expect($('prompt').disabled).toBe(true);
      expect($('prompt').placeholder).toBe('Start a fork to continue from here.');
      expect($('send').textContent).toContain('Start fork');
      expect($('send').disabled).toBe(false);
      expect($('chat-form').dataset.step).toBe('true');
      expect(text(document.querySelector('.composer-hint'))).toBe('Rewind mode · prompt 2 of 3. Click Start fork to continue from here, or Cancel.');
      expect($('lock-chat').disabled).toBe(true);
    });

    it('hides the Compact button in rewind mode, and brings it back when the mode ends', async () => {
      const { mock } = await boot();
      expect($('compact-chat')).not.toBeNull();
      expect($('compact-chat').disabled).toBe(false);
      await enterRewindMode();
      expect($('compact-chat')).toBeNull(); // not drawn at all, not just disabled
      await rewind();
      expect($('compact-chat')).toBeNull(); // still hidden while stepping
      $('forward').click();
      expect($('compact-chat')).toBeNull(); // and at the end of the mode
      $('rewind-cancel').click();
      expect($('compact-chat')).not.toBeNull();
      expect($('compact-chat').disabled).toBe(false);
      $('compact-chat').click(); // wired up again: it really compacts
      await settle();
      expect(mock.called('POST /api/conversations/:id/compact')).toBe(true);
    });

    it('brings Compact back after Start fork too', async () => {
      await boot();
      await rewindConfirmed();
      expect($('compact-chat')).toBeNull();
      $('chat-form').requestSubmit();
      await confirm();
      expect($('compact-chat')).not.toBeNull();
    });

    it('Forward steps toward the end, and reaching the end does not leave rewind mode', async () => {
      await boot();
      await rewindConfirmed();
      await rewind();
      expect($('forward').disabled).toBe(false);
      $('forward').click();
      expect(document.querySelectorAll('.message')).toHaveLength(4);
      $('forward').click();
      expect(document.querySelectorAll('.message')).toHaveLength(6); // every message is on screen again...
      expect($('chat-form').dataset.step).toBe('true'); // ...and the mode goes on
      expect($('send').textContent).toContain('Start fork');
      expect($('prompt').disabled).toBe(true);
      expect($('forward').disabled).toBe(true); // nothing further forward
      expect($('rewind-cancel')).not.toBeNull();
      expect(text(document.querySelector('.composer-hint'))).toBe('Rewind mode · prompt 3 of 3. Click Start fork to continue from here, or Cancel.');
    });

    it('shows a Cancel button next to Forward, only in rewind mode', async () => {
      await boot();
      expect($('rewind-cancel')).toBeNull();
      expect($('forward')).toBeNull();
      await rewindConfirmed();
      expect($('forward').nextElementSibling).toBe($('rewind-cancel'));
      expect(text($('rewind-cancel'))).toBe('Cancel');
    });

    it('lets the user move through every message, back and forth, without leaving rewind mode', async () => {
      await boot();
      await rewindConfirmed(); // 2 of 3
      const seen = [];
      const note = () => seen.push([document.querySelectorAll('.message').length, $('chat-form').dataset.step]);
      await rewind(); note(); // 1 of 3
      $('forward').click(); note(); // 2
      $('forward').click(); note(); // 3
      await rewind(); note(); // 2
      await rewind(); note(); // 1
      expect(seen).toEqual([[2, 'true'], [4, 'true'], [6, 'true'], [4, 'true'], [2, 'true']]);
      expect(document.querySelector('.modal')).toBeNull(); // the popup is only for entering the mode
      expect($('rewind').disabled).toBe(true); // the first prompt: nothing further back
    });

    it('Cancel leaves rewind mode: everything is back, nothing was sent or changed', async () => {
      const { server, mock } = await boot();
      await rewindConfirmed();
      await rewind();
      $('rewind-cancel').click();
      expect($('chat-form').dataset.step).toBe('false');
      expect(document.querySelectorAll('.message')).toHaveLength(6);
      expect($('send').textContent).toContain('Send message');
      expect($('prompt').disabled).toBe(false);
      expect($('rewind-cancel')).toBeNull();
      expect($('forward')).toBeNull();
      expect(document.activeElement).toBe($('prompt'));
      expect(mock.called('POST /api/conversations/:id/fork')).toBe(false);
      expect(mock.called('POST /api/conversations/:id/messages')).toBe(false);
      expect(server.conversation.conversation_id).toBe('c1');
      expect(server.conversation.messages).toHaveLength(6);
    });

    it('the mode can be entered again after Cancel, and asks again', async () => {
      await boot();
      await rewindConfirmed();
      $('rewind-cancel').click();
      await rewind();
      expect(popupTitle()).toBe('Entering rewind mode');
    });

    it('Start fork at the end of rewind mode copies the whole conversation, and leaves the mode', async () => {
      const { mock, server } = await boot();
      await rewindConfirmed();
      $('forward').click(); // back at the last message, still in rewind mode
      $('chat-form').requestSubmit();
      expect(text(modal())).toContain('up to prompt 3 copied into it');
      await confirm();
      expect(mock.lastBody('POST /api/conversations/:id/fork')).toEqual({ through_message_id: 'm6' });
      expect(server.conversation.conversation_id).toBe('fork-1');
      expect($('chat-form').dataset.step).toBe('false');
      expect($('send').textContent).toContain('Send message');
      expect($('rewind-cancel')).toBeNull();
    });

    it('the buttons are off while a request is running', async () => {
      await boot();
      await rewindConfirmed();
      const { setBusyUI } = await import('./chat-ui.js');
      setBusyUI(true, true, () => {});
      expect($('rewind-cancel').disabled).toBe(true);
      expect($('rewind').disabled).toBe(true);
      setBusyUI(false, true, null);
      expect($('rewind-cancel').disabled).toBe(false);
    });

    it('asks "are you sure" before Start fork, and Cancel changes nothing', async () => {
      const { mock } = await boot();
      await rewindConfirmed();
      $('chat-form').requestSubmit();
      expect(popupTitle()).toBe('Start a fork from this point?');
      expect(text(modal())).toContain('Are you sure you want to start the fork from this point?');
      expect(text(modal())).toContain('up to prompt 2 copied into it');
      cancel();
      await settle();
      expect(mock.called('POST /api/conversations/:id/fork')).toBe(false);
      expect($('send').textContent).toContain('Start fork'); // still in step mode
      expect(document.querySelectorAll('.message')).toHaveLength(4);
    });

    it('Start fork copies up to the point on screen, sends nothing, and gives back an enabled empty composer', async () => {
      const { server, mock } = await boot();
      await rewindConfirmed();
      $('prompt').value = 'typed somewhere else';
      $('chat-form').requestSubmit();
      await confirm();
      expect(mock.lastBody('POST /api/conversations/:id/fork')).toEqual({ through_message_id: 'm4' });
      expect(mock.called('POST /api/conversations/:id/messages')).toBe(false); // Start fork never sends
      expect(server.conversation.conversation_id).toBe('fork-1');
      expect(document.querySelectorAll('.message')).toHaveLength(4);
      expect($('send').textContent).toContain('Send message');
      expect($('prompt').disabled).toBe(false);
      expect($('prompt').value).toBe('');
      expect(document.activeElement).toBe($('prompt'));
      expect($('chat-form').dataset.step).toBe('false');
      expect(text($('fork-note'))).toBe('Forked from Sample conversation');
      expect(toastText()).toBe('Forked from Sample conversation.');
      expect($('forward')).toBeNull();
    });

    it('after the fork the first prompt is an ordinary send to the new conversation', async () => {
      const { mock } = await boot();
      await rewindConfirmed();
      $('chat-form').requestSubmit();
      await confirm();
      submit('what next');
      await settle();
      const sent = mock.calls.find((c) => c.key === 'POST /api/conversations/:id/messages');
      expect(sent.path).toBe('/api/conversations/fork-1/messages');
      expect(document.querySelectorAll('.message')).toHaveLength(6);
    });

    it('a failed fork keeps the popup open with the reason, and the view where it was', async () => {
      const { server } = await boot();
      server.failFork = apiError(409, 'prompt_in_progress', 'A prompt is still waiting for its reply. Wait for it, or stop it, first.');
      await rewindConfirmed();
      $('chat-form').requestSubmit();
      await confirm();
      expect(text(document.querySelector('.modal-error'))).toBe('A prompt is still waiting for its reply. Wait for it, or stop it, first.');
      expect(modal()).not.toBeNull();
      expect(server.conversation.conversation_id).toBe('c1');
      expect($('send').textContent).toContain('Start fork');
    });

    it('a full conversation can still start a fork from a stepped-back view', async () => {
      await boot({ config: { max_user_prompts: 3 } });
      expect($('send').disabled).toBe(true);
      await rewindConfirmed();
      expect($('send').disabled).toBe(false); // forking is how a full conversation carries on
      expect(text(document.querySelector('.composer-hint'))).not.toContain('full');
    });

    it('stays in step mode through a busy/idle cycle: the label and the textarea do not reset', async () => {
      await boot();
      await rewindConfirmed();
      const { setBusyUI } = await import('./chat-ui.js');
      setBusyUI(true, true, () => {});
      expect($('send').textContent).toContain('Stop');
      setBusyUI(false, true, null);
      expect($('send').textContent).toContain('Start fork');
      expect($('prompt').disabled).toBe(true);
    });

    it('opening another chat, or starting a new one, leaves step mode', async () => {
      await boot({ otherChats: [{ conversation_id: 'c9', name: 'Another', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', prompt_count: 1, messages: [msg(1, 'user', 'hi'), msg(2, 'assistant', 'hello')], locked: false }] });
      await rewindConfirmed();
      await openChat();
      modal().querySelector('input[value="c9"]').checked = true;
      modal().querySelector('form').requestSubmit();
      await settle();
      expect($('chat-form').dataset.step).toBe('false');
      expect($('send').textContent).toContain('Send message');
    });
  });

  describe('the conversation name in the top bar', () => {
    it('sits to the right of the File menu, not in the chat card', async () => {
      await boot();
      const title = $('topbar-title');
      expect(title).not.toBeNull();
      expect(title.parentElement.classList.contains('topbar')).toBe(true);
      expect($('topbar-file').nextElementSibling).toBe(title);
      expect(title.contains($('conversation-name'))).toBe(true);
      expect(title.contains($('rename-chat'))).toBe(true);
      expect(text($('conversation-name'))).toBe('Sample conversation');
      expect(document.querySelector('.chat-card').contains($('conversation-name'))).toBe(false);
      expect(document.querySelector('.chat-card').contains($('rename-chat'))).toBe(false);
    });

    it('is drawn once and kept up to date as the page redraws', async () => {
      await boot();
      $('rewind').click();
      document.querySelector('.modal-form').requestSubmit();
      $('forward').click();
      expect(document.querySelectorAll('#topbar-title')).toHaveLength(1);
      expect(document.querySelectorAll('#conversation-name')).toHaveLength(1);
    });

    it('follows a rename, and Rename still works from the top bar', async () => {
      await boot();
      $('rename-chat').click();
      field('name').value = 'Renamed from the bar';
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(text($('conversation-name'))).toBe('Renamed from the bar');
      expect($('topbar-file').nextElementSibling.id).toBe('topbar-title');
    });

    it('shows where a fork came from under the name', async () => {
      await boot({ config: { forked_from_conversation_id: 'c0', forked_from_name: 'The source' } });
      expect(text($('topbar-title').querySelector('#fork-note'))).toBe('Forked from The source');
    });
  });

  describe('Config', () => {
    const OFF_ON = { show_compact_button: false, show_rewind_button: true }; // what a new user has
    const flip = async (name) => {
      const input = modal().querySelector(`input[name="${name}"]`);
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      return input;
    };

    it('opens from File > Config as a popup with two switches and no "locked" text', async () => {
      await boot({ appOverrides: { preferences: OFF_ON } });
      openConfig();
      expect(modal().querySelector('h2').textContent).toBe('Config');
      expect(modal().textContent).not.toContain('Locked for educational purposes');
      expect(modal().textContent).not.toContain('Start a new chat for different settings');
      const switches = [...modal().querySelectorAll('input.ios-switch')];
      expect(switches.map((i) => [i.name, i.getAttribute('role'), i.type])).toEqual([['compact', 'switch', 'checkbox'], ['rewind', 'switch', 'checkbox']]);
      expect(text(modal().querySelector('label[for="config-compact"]'))).toBe('Show Compact button');
      expect(text(modal().querySelector('label[for="config-rewind"]'))).toBe('Show Rewind button');
      expect(modal().querySelectorAll('.modal-actions button')).toHaveLength(1); // just OK
      expect(modal().querySelector('.modal-actions button').textContent).toBe('OK');
    });

    it('defaults: Compact off, Rewind on', async () => {
      await boot({ appOverrides: { preferences: OFF_ON } });
      expect($('compact-chat')).toBeNull();
      expect($('rewind')).not.toBeNull();
      openConfig();
      expect(modal().querySelector('input[name="compact"]').checked).toBe(false);
      expect(modal().querySelector('input[name="rewind"]').checked).toBe(true);
    });

    it('turning Compact on shows the button at once and saves the choice', async () => {
      const { mock } = await boot({ appOverrides: { preferences: OFF_ON } });
      openConfig();
      await flip('compact');
      expect($('compact-chat')).not.toBeNull();
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ show_compact_button: true });
      expect(modal()).not.toBeNull(); // the popup stays until OK
    });

    it('turning Compact off again hides it', async () => {
      const { mock } = await boot({ appOverrides: { preferences: { show_compact_button: true } } });
      expect($('compact-chat')).not.toBeNull();
      openConfig();
      await flip('compact');
      expect($('compact-chat')).toBeNull();
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ show_compact_button: false });
    });

    it('turning Rewind off hides the Rewind button and saves it; on brings it back', async () => {
      const { mock } = await boot({ appOverrides: { preferences: OFF_ON } });
      openConfig();
      await flip('rewind');
      expect($('rewind')).toBeNull();
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ show_rewind_button: false });
      await flip('rewind');
      expect($('rewind')).not.toBeNull();
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ show_rewind_button: true });
    });

    it('the two switches are independent', async () => {
      await boot({ appOverrides: { preferences: OFF_ON } });
      openConfig();
      await flip('compact');
      expect($('rewind')).not.toBeNull();
      await flip('rewind');
      expect($('compact-chat')).not.toBeNull();
      expect($('rewind')).toBeNull();
    });

    it('OK closes the popup and keeps the choices', async () => {
      await boot({ appOverrides: { preferences: OFF_ON } });
      openConfig();
      await flip('compact');
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(modal()).toBeNull();
      expect($('compact-chat')).not.toBeNull();
    });

    it('is remembered: a page that loads with the saved preferences shows the buttons they ask for', async () => {
      await boot({ appOverrides: { preferences: { show_compact_button: true, show_rewind_button: false } } });
      expect($('compact-chat')).not.toBeNull();
      expect($('rewind')).toBeNull();
      openConfig();
      expect(modal().querySelector('input[name="compact"]').checked).toBe(true);
      expect(modal().querySelector('input[name="rewind"]').checked).toBe(false);
    });

    it('when saving fails the switch goes back, the page goes back, and the popup says why', async () => {
      const { server } = await boot({ appOverrides: { preferences: OFF_ON } });
      server.failPrefs = apiError(500, 'oops', 'The server hit a problem.');
      openConfig();
      const input = await flip('compact');
      expect(input.checked).toBe(false);
      expect($('compact-chat')).toBeNull();
      expect(text(modal().querySelector('.modal-error'))).toBe('The server hit a problem.');
    });

    it('a switch changed while a reply is on its way waits for the reply, then shows', async () => {
      const { server } = await boot({ messages: [], isSample: false, appOverrides: { preferences: OFF_ON } });
      server.hold = true;
      submit('first');
      await settle();
      openConfig();
      await flip('compact');
      expect($('send').textContent).toContain('Stop'); // the busy page was not redrawn under the user
      server.release();
      await settle();
      expect($('compact-chat')).not.toBeNull();
    });

    it('rewind mode keeps its own buttons even when the Rewind button is switched off', async () => {
      await boot();
      $('rewind').click();
      document.querySelector('.modal-form').requestSubmit(); // entering rewind mode
      openConfig();
      await flip('rewind');
      expect($('rewind')).not.toBeNull(); // it steps back inside the mode
      expect($('forward')).not.toBeNull();
      expect($('rewind-cancel')).not.toBeNull();
      modal().querySelector('form').requestSubmit();
      $('rewind-cancel').click();
      expect($('rewind')).toBeNull(); // out of the mode, the switch is respected
    });
  });

  describe('lessons', () => {
    const avatar = { avatar_slug: 'guide', file: 'guide.webp', alt: 'Rex', facing: 'front' };
    const s = (position, title, target, over = {}) => ({ position, title, body: title, target, action: 'none', action_arg: null, on_next: 'none', on_target_gone: 'stop', placement: 'top', avatar, ...over });
    const DEMO = {
      slug: 'chat-start-conversation', page: 'chat', title: 'Start a conversation', summary: 'Learn the popup.', step_count: 3,
      progress: { status: 'not_started', current_step: 0 },
    };
    const DETAIL = {
      ...DEMO, version: 1,
      steps: [
        s(0, 'Welcome', null),
        s(1, 'Open File > New', '#file-new', { action: 'open-menu', on_next: 'click' }),
        s(2, 'Name it', '#new-chat-name', { action: 'fill', action_arg: 'My first conversation' }),
        s(3, 'Done', null),
      ],
    };
    const lessonApp = (progress = DEMO.progress) => ({ lessons: [{ ...DEMO, progress }], lessonDetails: { [DEMO.slug]: DETAIL } });
    const cardTitle = () => document.querySelector('.lesson-title')?.textContent;
    const next = () => document.querySelector('[data-lesson-next]').click();
    afterEach(() => document.querySelector('[data-lesson-skip]')?.click()); // a lesson left running would also swallow the next test's Escape

    it('File > Lessons lists the lessons for this page and Start plays one over the real popup', async () => {
      await boot({ appOverrides: lessonApp() });
      $('file-menu-btn').click();
      $('file-lessons').click();
      await settle();
      expect(document.querySelector('.modal-head h2').textContent).toBe('Lessons');
      expect(document.querySelector('.lesson-list h3').textContent).toBe('Start a conversation');
      expect(document.querySelector('.lesson-status').textContent).toBe('Not started');
      document.querySelector('[data-lesson]').click();
      await settle();
      expect(cardTitle()).toBe('Welcome');
      next(); // Start
      expect(cardTitle()).toBe('Open File > New');
      next(); // Next clicks File > New for the user: the real New conversation popup opens
      expect(modal().querySelector('#new-chat-name')).not.toBeNull();
      await settle();
      expect(cardTitle()).toBe('Name it');
      expect(field('name').value).toBe('My first conversation');
      expect(document.querySelector('.lesson-ring').hidden).toBe(false);
    });

    it('a completed lesson says Redo', async () => {
      await boot({ appOverrides: lessonApp({ status: 'completed', current_step: 3 }) });
      $('file-menu-btn').click();
      $('file-lessons').click();
      await settle();
      expect(document.querySelector('.lesson-status').textContent).toBe('Completed');
      expect(document.querySelector('[data-lesson]').textContent).toBe('Redo');
    });

    it('the Welcome back popup offers Take the tour to someone with no completed lesson, and the tour starts the lesson', async () => {
      await boot({ keepArrival: true, appOverrides: lessonApp() });
      const ids = [...document.querySelectorAll('[data-choice]')].map((b) => b.dataset.choice);
      expect(ids).toEqual(['open', 'new', 'tour']);
      document.querySelector('[data-choice="tour"]').click();
      await settle();
      expect(cardTitle()).toBe('Welcome');
    });

    it('no tour button once a lesson is completed, or when there are no lessons', async () => {
      await boot({ keepArrival: true, appOverrides: lessonApp({ status: 'completed', current_step: 3 }) });
      expect([...document.querySelectorAll('[data-choice]')].map((b) => b.dataset.choice)).toEqual(['open', 'new']);
      await boot({ keepArrival: true });
      expect([...document.querySelectorAll('[data-choice]')].map((b) => b.dataset.choice)).toEqual(['open', 'new']);
    });

    // The lesson (backend/db/lesson_seeds/chat_start_conversation.py) points at these ids; a rename here breaks it.
    it('keeps the ids the Start a conversation lesson points at', async () => {
      await boot();
      newChat();
      for (const id of ['name', 'agent', 'provider', 'model', 'reasoning', 'temperature', 'kbsummary', 'brief']) {
        expect(modal().querySelector(`#new-chat-${id}`), `#new-chat-${id}`).not.toBeNull();
      }
      expect(modal().querySelector('.modal-actions button[type=submit]')).not.toBeNull();
      expect(document.getElementById('file-new')).not.toBeNull();
    });
  });

  describe('returning to the page', () => {
    const popupTitle = () => document.querySelector('.modal-head h2')?.textContent;
    const choices = () => [...document.querySelectorAll('[data-choice]')];

    it('asks whether to open a chat or start a new one, with those two options', async () => {
      await boot({ keepArrival: true });
      expect(popupTitle()).toBe('Welcome back');
      expect(choices().map((b) => [b.dataset.choice, b.textContent])).toEqual([['open', 'Open Chat'], ['new', 'New Chat']]);
    });

    it('Open Chat opens the list of chats', async () => {
      const { server } = await boot({ keepArrival: true });
      server.otherChats = [{ conversation_id: 'c9', name: 'Earlier chat', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', prompt_count: 1, locked: false, messages: [] }];
      choices()[0].click();
      await settle();
      expect(popupTitle()).toBe('Open a chat');
      expect(modal().textContent).toContain('Earlier chat');
    });

    it('New Chat opens the New conversation popup', async () => {
      await boot({ keepArrival: true });
      choices()[1].click();
      await settle();
      expect(popupTitle()).toBe('New conversation');
      expect(field('name')).not.toBeNull();
    });

    it('dismissing it keeps the chat that was on screen', async () => {
      const { mock } = await boot({ keepArrival: true });
      document.querySelector('[data-modal-close]').click();
      await settle();
      expect(modal()).toBeNull();
      expect(text($('conversation-name'))).toBe('Sample conversation');
      expect(document.querySelectorAll('.message')).toHaveLength(6);
      expect(mock.called('GET /api/conversations')).toBe(false); // nothing was asked for until the user picks
    });

    it('Escape dismisses it too', async () => {
      await boot({ keepArrival: true });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(modal()).toBeNull();
    });

    it('opens once per visit, not again after a chat is started', async () => {
      await boot({ keepArrival: true });
      choices()[1].click();
      await settle();
      field('name').value = 'Started from the popup';
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(text($('conversation-name'))).toBe('Started from the popup');
      expect(document.querySelector('[data-choice]')).toBeNull();
      expect(popupTitle()).toBeUndefined();
    });
  });

  describe('Delete', () => {
    const deleteButton = () => $('delete-chat');
    const popupTitle = () => document.querySelector('.modal-head h2')?.textContent;
    const confirmDelete = async () => {
      document.querySelector('.modal-form').requestSubmit();
      await settle();
    };

    it('has a trash can at the right edge of the Settings title, with a tooltip', async () => {
      await boot();
      const wrap = document.querySelector('.side-settings-wrap');
      expect(wrap).not.toBeNull();
      expect(wrap.contains($('side-settings'))).toBe(true);
      expect(wrap.contains(deleteButton())).toBe(true);
      expect($('side-settings').contains(deleteButton())).toBe(false); // outside the <details>, so it stays when Settings is closed
      expect(deleteButton().previousElementSibling).toBe($('side-settings'));
      expect(deleteButton().dataset.tip).toBe('Delete this chat');
      expect(deleteButton().getAttribute('aria-label')).toBe('Delete this chat');
      expect(deleteButton().classList.contains('tooltip')).toBe(true);
      expect(deleteButton().querySelector('svg')).not.toBeNull();
    });

    it('is still there when Settings is collapsed', async () => {
      await boot();
      $('side-settings').open = false;
      expect(deleteButton().isConnected).toBe(true);
      expect(deleteButton().disabled).toBe(false);
    });

    it('opens a popup that warns it can not be undone and asks to confirm', async () => {
      await boot();
      deleteButton().click();
      expect(popupTitle()).toBe('Delete this chat?');
      expect(text(modal())).toContain('Warning: deleting this chat can not be undone. Confirm deletion to continue.');
      expect(document.querySelector('.modal-form button[type="submit"]').textContent).toBe('Confirm deletion');
    });

    it('Cancel deletes nothing', async () => {
      const { mock } = await boot();
      deleteButton().click();
      document.querySelector('[data-modal-close]').click();
      await settle();
      expect(mock.called('DELETE /api/conversations/:id')).toBe(false);
      expect(modal()).toBeNull();
      expect(text($('conversation-name'))).toBe('Sample conversation');
    });

    it('confirming deletes the chat, clears the interface and opens the New conversation popup', async () => {
      const { server, mock } = await boot();
      deleteButton().click();
      await confirmDelete();
      expect(mock.calls.find((c) => c.key === 'DELETE /api/conversations/:id').path).toBe('/api/conversations/c1');
      expect(server.deleted).toEqual(['c1']);
      expect(toastText()).toBe('Chat deleted.');
      // the interface is cleared: no chat, no messages, nothing to type into
      expect(text($('conversation-name'))).toBe('No chat open');
      expect(document.querySelectorAll('.message')).toHaveLength(0);
      expect(text(document.querySelector('.empty'))).toContain('No chat open.');
      expect($('prompt').disabled).toBe(true);
      expect($('prompt').placeholder).toBe('Start a new chat with File > New.');
      expect($('send').disabled).toBe(true);
      expect(deleteButton().disabled).toBe(true);
      expect($('lock-chat').disabled).toBe(true);
      expect($('rename-chat').disabled).toBe(true);
      expect($('chat-api-log').disabled).toBe(true);
      expect(text(document.querySelector('.side-settings-wrap'))).toContain('No chat open.');
      // and the New conversation popup is open
      expect(popupTitle()).toBe('New conversation');
      expect(mock.count('GET /api/conversations/current')).toBe(1); // no other chat was loaded in its place
    });

    it('the New conversation popup after a deletion does not offer the deleted chat\'s settings', async () => {
      await boot();
      deleteButton().click();
      await confirmDelete();
      expect(modal().querySelector('#use-chat-settings')).toBeNull();
      expect(field('name')).not.toBeNull();
    });

    it('Cancel on that popup leaves the cleared interface, and New Chat still works from there', async () => {
      const { mock } = await boot();
      deleteButton().click();
      await confirmDelete();
      document.querySelector('[data-modal-close]').click();
      expect(modal()).toBeNull();
      expect(text($('conversation-name'))).toBe('No chat open');
      submit('typed anyway');
      await settle();
      expect(mock.called('POST /api/conversations/:id/messages')).toBe(false); // there is no chat to send to
      $('new-chat').click();
      expect(popupTitle()).toBe('New conversation');
    });

    it('starting a chat from that popup fills the interface and opens the composer', async () => {
      const { server, mock } = await boot();
      deleteButton().click();
      await confirmDelete();
      field('name').value = 'After the delete';
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(mock.called('POST /api/conversations')).toBe(true);
      expect(text($('conversation-name'))).toBe('After the delete');
      expect($('prompt').disabled).toBe(false);
      expect(deleteButton().disabled).toBe(false);
      submit('first prompt in the new chat');
      await settle();
      expect(mock.calls.find((c) => c.key === 'POST /api/conversations/:id/messages').path).toBe('/api/conversations/c2/messages');
      expect(server.conversation.messages).toHaveLength(2);
    });

    it('leaves step mode when the chat is deleted', async () => {
      await boot();
      $('rewind').click();
      document.querySelector('.modal-form').requestSubmit();
      expect($('chat-form').dataset.step).toBe('true');
      deleteButton().click();
      await confirmDelete();
      expect($('chat-form').dataset.step).toBe('false');
      expect($('send').textContent).toContain('Send message');
    });

    it('keeps the popup open with the reason when the server refuses', async () => {
      const { server } = await boot();
      server.failDelete = apiError(404, 'not_found', 'Conversation not found.');
      deleteButton().click();
      await confirmDelete();
      expect(text(document.querySelector('.modal-error'))).toBe('Conversation not found.');
      expect(modal()).not.toBeNull();
      expect(text($('conversation-name'))).toBe('Sample conversation');
    });

    it('is disabled while a reply is on its way', async () => {
      const { server } = await boot({ messages: [], isSample: false });
      server.hold = true;
      submit('first');
      await settle();
      expect(deleteButton().disabled).toBe(true);
      server.release();
      await settle();
      expect(deleteButton().disabled).toBe(false);
    });
  });

  describe('Lock', () => {
    const popupForm = () => document.querySelector('.modal-form');
    const popupTitle = () => document.querySelector('.modal-head h2')?.textContent;
    const lockButton = () => $('lock-chat');

    it('has a lock button next to Send, with a tooltip', async () => {
      await boot();
      expect(lockButton()).not.toBeNull();
      expect(lockButton().classList.contains('tooltip')).toBe(true);
      expect(lockButton().dataset.tip).toBe('Lock this conversation');
      expect(lockButton().getAttribute('aria-label')).toBe('Lock this conversation');
      expect(lockButton().nextElementSibling).toBe($('send'));
      expect(lockButton().querySelector('svg')).not.toBeNull();
    });

    it('is disabled until there is an answered prompt, and while a reply is on its way', async () => {
      const { server } = await boot({ messages: [], isSample: false });
      expect(lockButton().disabled).toBe(true);
      server.hold = true;
      submit('first');
      await settle();
      expect(lockButton().disabled).toBe(true);
      server.release();
      await settle();
      expect(lockButton().disabled).toBe(false); // now there is an answered prompt
    });

    it('opens a popup that says no more prompts can be added but it stays available for replay', async () => {
      await boot();
      lockButton().click();
      expect(popupTitle()).toBe('Lock this conversation?');
      expect(text(modal())).toContain('You will not be able to add more prompts to this conversation.');
      expect(text(modal())).toContain('It will still be available for replay.');
    });

    it('Cancel locks nothing', async () => {
      const { mock } = await boot();
      lockButton().click();
      document.querySelector('[data-modal-close]').click();
      await settle();
      expect(mock.called('POST /api/conversations/:id/lock')).toBe(false);
      expect($('chat-form').dataset.locked).toBe('false');
    });

    it('confirming locks it: the composer closes, and a banner offers to fork', async () => {
      const { mock } = await boot();
      lockButton().click();
      popupForm().requestSubmit();
      await settle();
      expect(mock.called('POST /api/conversations/:id/lock')).toBe(true);
      expect(toastText()).toBe('Conversation locked.');
      expect($('chat-form').dataset.locked).toBe('true');
      expect($('prompt').disabled).toBe(true);
      expect($('prompt').placeholder).toBe('This conversation is locked.');
      expect($('send').disabled).toBe(true);
      expect(lockButton().disabled).toBe(true);
      expect($('lock-badge')).not.toBeNull();
      expect(text(document.querySelector('.lock-banner'))).toContain('This conversation is locked.');
      expect($('fork-continue')).not.toBeNull();
      expect($('rewind').disabled).toBe(false); // stepping back and starting a fork is the way on
    });

    it('shows the reason in the popup when the server refuses', async () => {
      const { server } = await boot();
      server.failLock = apiError(409, 'prompt_in_progress', 'A prompt is still waiting for its reply. Wait for it, or stop it, first.');
      lockButton().click();
      popupForm().requestSubmit();
      await settle();
      expect(text(document.querySelector('.modal-error'))).toBe('A prompt is still waiting for its reply. Wait for it, or stop it, first.');
      expect($('chat-form').dataset.locked).toBe('false');
    });

    it('Fork to continue asks first, then copies the whole conversation into an open one', async () => {
      const { mock } = await boot({ config: { locked: true, lock_reason: 'replay' } });
      $('fork-continue').click();
      expect(popupTitle()).toBe('This conversation is locked');
      popupForm().requestSubmit();
      await settle();
      expect(mock.lastBody('POST /api/conversations/:id/fork')).toEqual({});
      expect($('chat-form').dataset.locked).toBe('false');
      expect($('prompt').disabled).toBe(false);
      expect($('lock-badge')).toBeNull();
      expect(document.querySelector('.lock-banner')).toBeNull();
    });

    it('a send refused because it was locked elsewhere shows the reason and does not keep the prompt', async () => {
      const { server } = await boot();
      server.conversation.locked = true; // locked in another tab after this page loaded
      submit('too late');
      await settle();
      expect(toastText()).toContain('This conversation is locked.');
      expect(messageCopies()).not.toContain('too late');
      expect($('chat-form').dataset.locked).toBe('true');
    });
  });

  describe('a locked conversation', () => {
    const locked = { locked: true, lock_reason: 'user' };
    const popupTitle = () => document.querySelector('.modal-head h2')?.textContent;

    it('landing on one shows the Welcome back choice, not the fork notice; dismissing it leaves the chat read-only with a banner', async () => {
      const { mock } = await boot({ config: locked, keepArrival: true });
      expect(popupTitle()).toBe('Welcome back');
      document.querySelector('[data-modal-close]').click();
      expect(mock.called('POST /api/conversations/:id/fork')).toBe(false);
      expect($('prompt').disabled).toBe(true);
      expect($('send').disabled).toBe(true);
      expect(text(document.querySelector('.composer-hint'))).toBe('Locked: replay it, or fork it to keep going.');
      expect($('fork-continue')).not.toBeNull(); // the banner is how a locked chat is continued
      expect(document.querySelectorAll('.message').length).toBeGreaterThan(0); // it can still be read
    });

    it('the banner\'s Fork to continue asks first, then creates the fork', async () => {
      const { server } = await boot({ config: locked });
      $('fork-continue').click();
      expect(popupTitle()).toBe('This conversation is locked');
      document.querySelector('.modal-form').requestSubmit();
      await settle();
      expect(server.conversation.conversation_id).toBe('fork-1');
      expect($('prompt').disabled).toBe(false);
    });

    it('an open conversation shows no notice and no banner', async () => {
      await boot();
      expect(modal()).toBeNull();
      expect(document.querySelector('.lock-banner')).toBeNull();
      expect($('lock-badge')).toBeNull();
    });

    it('opening a locked chat from File > Open shows the fork notice and does not open it', async () => {
      const { server, mock } = await boot({
        otherChats: [{ conversation_id: 'c9', name: 'Old plan', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', prompt_count: 1, locked: true, messages: [msg(1, 'user', 'hi'), msg(2, 'assistant', 'hello')] }],
      });
      await openChat();
      expect(text(modal())).toContain('Locked');
      modal().querySelector('input[value="c9"]').checked = true;
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(popupTitle()).toBe('This conversation is locked');
      expect(mock.called('POST /api/conversations/:id/open')).toBe(false); // a locked chat is not even touched by opening
      document.querySelector('[data-modal-close]').click();
      expect(server.conversation.conversation_id).toBe('c1'); // Cancel stays where it was
    });

    it('Create fork from File > Open forks that chat, and the fork is the one on screen', async () => {
      const { server, mock } = await boot({
        otherChats: [{ conversation_id: 'c9', name: 'Old plan', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', prompt_count: 1, locked: true, messages: [msg(1, 'user', 'hi'), msg(2, 'assistant', 'hello')] }],
      });
      await openChat();
      modal().querySelector('input[value="c9"]').checked = true;
      modal().querySelector('form').requestSubmit();
      await settle();
      document.querySelector('.modal-form').requestSubmit();
      await settle();
      expect(mock.calls.find((c) => c.key === 'POST /api/conversations/:id/fork').path).toBe('/api/conversations/c9/fork');
      expect(server.conversation.name).toBe('Old plan (fork)');
      expect(text($('conversation-name'))).toBe('Old plan (fork)');
      expect(toastText()).toBe('Forked from Old plan.');
    });

    it('the picker marks locked chats and forks', async () => {
      await boot({
        otherChats: [
          { conversation_id: 'c8', name: 'Source', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', prompt_count: 1, locked: true, messages: [] },
          { conversation_id: 'c9', name: 'Branch', agent_id: 'assistant', model: 'model-a', reasoning_level: 'default', prompt_count: 1, locked: false, forked_from_conversation_id: 'c8', messages: [] },
        ],
      });
      await openChat();
      const rows = [...modal().querySelectorAll('.chat-option')].map((r) => r.textContent);
      expect(rows.find((r) => r.includes('Source'))).toContain('Locked');
      expect(rows.find((r) => r.includes('Branch'))).toContain('Fork of Source');
    });
  });

  it('starts a new chat from the popup: name, agent, model, reasoning level and the KB summary tool', async () => {
    const { mock } = await boot();
    newChat();
    expect(modal()).not.toBeNull();
    expect(modal().querySelector('h2').textContent).toBe('New conversation');
    expect([...field('agent').options].map((o) => o.textContent)).toEqual(['General assistant', 'Code assistant', 'IT Security Assistant']);
    expect([...field('model').options].map((o) => o.value)).toEqual(['model-a', 'model-b', 'model-c']);
    expect([...field('reasoning').options].map((o) => o.value)).toEqual(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(field('kbsummary').checked).toBe(false); // off by default
    expect(field('briefreplies').checked).toBe(false); // so is Brief replies
    const kbRow = field('kbsummary').closest('.modal-check');
    expect(kbRow.nextElementSibling).toBe(field('briefreplies').closest('.modal-check')); // to the right of the KB summary tool
    expect(kbRow.parentElement.classList.contains('modal-grid')).toBe(true);
    expect(modal().textContent).toContain('Respond in 100 words or less.');
    expect(field('temperature').value).toBe('0'); // 0 by default
    expect(mock.called('POST /api/conversations')).toBe(false); // nothing starts until the popup is submitted
    field('name').value = 'Segmentation, high';
    field('agent').value = 'research';
    field('model').value = 'model-b';
    field('reasoning').value = 'high';
    field('temperature').value = '0.7';
    field('kbsummary').checked = true;
    field('briefreplies').checked = true;
    modal().querySelector('form').requestSubmit();
    await settle();
    expect(mock.lastBody('POST /api/conversations')).toEqual({
      name: 'Segmentation, high', agent_id: 'research', model: 'model-b', reasoning_level: 'high', temperature: 0.7, kb_summary_tool: true, brief_replies: true,
    }); // fmt: skip
    expect(modal()).toBeNull();
    expect($('conversation-name').textContent).toBe('Segmentation, high');
    expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-b', REASONING: 'High', TEMPERATURE: '0.7', 'KB SUMMARY TOOL': 'On', 'BRIEF REPLIES': 'Off' });
    expect(document.querySelector('.empty h2').textContent).toBe('Start with a prompt.');
    expect(mock.lastBody('PUT /api/preferences')).toEqual({ agent_id: 'research', model: 'model-b' }); // the next popup starts here
    submit('first message in the new chat');
    await settle();
    expect(mock.calls.at(-1).path).not.toContain('/c1/');
  });

  describe('copying a turn', () => {
    const copied = [];
    const turns = () => [...document.querySelectorAll('.message')];
    const button = (article) => article.querySelector('.copy-btn');

    beforeEach(() => {
      copied.length = 0;
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => copied.push(t) }, configurable: true });
    });

    it('puts a copy button on every turn: your prompts, the responses', async () => {
      await boot({ messages: [msg(1, 'user', 'first prompt'), msg(2, 'assistant', 'first answer', { demo: true, agent: 'General assistant' })], isSample: false });
      expect(turns().map((t) => button(t).getAttribute('aria-label'))).toEqual(['Copy prompt', 'Copy response']);
      expect(turns().map((t) => button(t).textContent)).toEqual(['Copy prompt', 'Copy response']);
    });

    it('copies a prompt\'s text exactly, and says so', async () => {
      await boot({ messages: [msg(1, 'user', 'plan <b>my</b>\nlaunch'), msg(2, 'assistant', 'ok')], isSample: false });
      button(turns()[0]).click();
      await settle();
      expect(copied).toEqual(['plan <b>my</b>\nlaunch']); // no markup, no label, no metadata
      expect(toastText()).toBe('Prompt copied.');
    });

    it('copies a response\'s text only, not its decision tree or tools', async () => {
      await boot({ messages: [msg(1, 'user', 'q'), msg(2, 'assistant', 'the answer text', { demo: true, agent: 'General assistant' })], isSample: false });
      button(turns()[1]).click();
      await settle();
      expect(copied).toEqual(['the answer text']);
      expect(toastText()).toBe('Response copied.');
    });

    it('copies the turn that was clicked, whichever it is', async () => {
      await boot();
      const all = turns();
      expect(all).toHaveLength(6);
      button(all[2]).click();
      await settle();
      button(all[5]).click();
      await settle();
      expect(copied).toEqual(['It is a creative workspace for small teams.', 'Project brief: A calmer place to create.']);
    });

    it('copies a summary that opens a compacted conversation', async () => {
      await boot({ messages: [msg(900, 'assistant', 'SUMMARY OF THE EARLIER CONVERSATION', { message_type: 'compacted_summary', model: 'model-a' })], isSample: false });
      const summary = turns()[0];
      expect(button(summary).getAttribute('aria-label')).toBe('Copy summary');
      button(summary).click();
      await settle();
      expect(copied).toEqual(['SUMMARY OF THE EARLIER CONVERSATION']);
      expect(toastText()).toBe('Summary copied.');
    });

    it('gives the turns a sent a moment ago a copy button too', async () => {
      await boot({ messages: [], isSample: false });
      submit('a new prompt');
      await settle();
      const [prompt, reply] = turns();
      button(prompt).click();
      await settle();
      expect(copied.at(-1)).toBe('a new prompt');
      button(reply).click();
      await settle();
      expect(copied.at(-1)).toBe('reply to: a new prompt');
    });

    it('says so when the browser will not copy', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('no')) }, configurable: true });
      await boot({ messages: [msg(1, 'user', 'x'), msg(2, 'assistant', 'y')], isSample: false });
      button(turns()[0]).click();
      await settle();
      expect(toastText()).toBe('Copy unavailable in this browser. Select the text to copy.');
    });
  });

  describe('models from several APIs', () => {
    const APPS = { settings: { models: ['H100::llama', 'A100::llama', 'A100::mixtral'], connected: true, connections: [] } };

    const pick = (provider) => {
      field('provider').value = provider;
      field('provider').dispatchEvent(new Event('change'));
    };

    it('offers an API provider dropdown and lists only that API\'s models, the value being the label-qualified choice', async () => {
      await boot({ appOverrides: APPS, config: { model: 'H100::llama' } });
      newChat();
      expect([...field('provider').options].map((o) => o.value)).toEqual(['H100', 'A100']);
      expect(field('provider').value).toBe('H100'); // follows the default model
      expect([...field('model').options].map((o) => o.value)).toEqual(['H100::llama']);
      pick('A100');
      const options = [...field('model').options];
      expect(options.map((o) => o.textContent)).toEqual(['llama', 'mixtral']);
      expect(options.map((o) => o.value)).toEqual(['A100::llama', 'A100::mixtral']);
    });

    it('starts the conversation on the chosen API\'s model and shows it as label · model', async () => {
      const { mock } = await boot({ appOverrides: APPS, config: { model: 'H100::llama' } });
      newChat();
      pick('A100');
      field('model').value = 'A100::llama';
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(mock.lastBody('POST /api/conversations').model).toBe('A100::llama');
      expect(chips().MODEL).toBe('A100 · llama');
    });

    it('shows the chat\'s model as label · model in the chips and on each answer', async () => {
      await boot({ appOverrides: APPS, config: { model: 'H100::llama' }, messages: [msg(1, 'user', 'hi'), msg(2, 'assistant', 'hello', { model: 'H100::llama', agent: 'General assistant' })], isSample: false });
      expect(chips().MODEL).toBe('H100 · llama');
      expect(document.querySelector('.message.assistant .message-meta span').textContent).toBe('H100 · llama');
    });

    it('still shows a plain model name (a demo model, or an older chat) as it is', async () => {
      await boot();
      expect(chips().MODEL).toBe('model-a');
    });
  });

  describe('the prompt limit', () => {
    const composer = () => ({ prompt: $('prompt'), send: $('send'), hint: document.querySelector('.composer-hint') });

    it('shows how many prompts are used, and offers to send while there is room', async () => {
      await boot({ config: { max_user_prompts: 10 } }); // the sample conversation has 3
      const { prompt, send, hint } = composer();
      expect(text(hint)).toBe('3 of 10 prompts · Replay it on another model to compare.');
      expect(prompt.disabled).toBe(false);
      expect(send.disabled).toBe(false);
      expect($('chat-form').dataset.full).toBe('false');
    });

    it('closes the composer when the conversation is full and says how to carry on', async () => {
      await boot({ config: { max_user_prompts: 3 } });
      const { prompt, send, hint } = composer();
      expect(prompt.disabled).toBe(true);
      expect(prompt.placeholder).toBe('This conversation is full. Start a new one with File > New.');
      expect(send.disabled).toBe(true);
      expect(text(hint)).toBe('3 of 3 prompts: this conversation is full. Start a new one with File > New, or Rewind and start a fork.');
      expect(hint.classList.contains('full')).toBe(true);
      expect($('chat-form').dataset.full).toBe('true');
      expect($('rewind').disabled).toBe(false); // stepping back and starting a fork is the way on
    });

    it('does not send when a prompt is submitted to a full conversation, and says why', async () => {
      const { mock } = await boot({ config: { max_user_prompts: 3 } });
      $('prompt').disabled = false; // as if it were typed before it filled up
      $('prompt').value = 'one too many';
      submit('one too many');
      await settle();
      expect(mock.calls.some((c) => c.key === 'POST /api/conversations/:id/messages')).toBe(false);
      expect(toastText()).toBe('This conversation has reached its limit of 3 prompts. Start a new one with File > New.');
    });

    it('fills up as prompts are sent: the last one allowed closes the composer', async () => {
      await boot({ messages: [msg(1, 'user', 'first'), msg(2, 'assistant', 'one')], isSample: false, config: { max_user_prompts: 2 } });
      expect(text(composer().hint)).toContain('1 of 2 prompts');
      expect(composer().prompt.disabled).toBe(false);
      submit('second');
      await settle();
      expect(text(composer().hint)).toContain('2 of 2 prompts: this conversation is full');
      expect(composer().prompt.disabled).toBe(true);
      expect(composer().send.disabled).toBe(true);
    });

    it('a full conversation carries on in a fork: Rewind, Start fork, and the composer is open again', async () => {
      await boot({ config: { max_user_prompts: 3 } });
      expect(composer().prompt.disabled).toBe(true);
      $('rewind').click();
      document.querySelector('.modal-form').requestSubmit(); // entering rewind mode asks first (it does not step back)
      $('rewind').click(); // now step back one prompt
      $('chat-form').requestSubmit();
      document.querySelector('.modal-form').requestSubmit();
      await settle();
      expect(text(composer().hint)).toContain('2 of 3 prompts');
      expect(composer().prompt.disabled).toBe(false);
      expect(composer().prompt.value).toBe('');
    });

    it('stays closed while a reply is on its way and after it, when that reply fills the conversation', async () => {
      const { server } = await boot({ messages: [msg(1, 'user', 'first'), msg(2, 'assistant', 'one')], isSample: false, config: { max_user_prompts: 2 } });
      server.hold = true;
      submit('second');
      await settle();
      expect(composer().prompt.disabled).toBe(true); // a reply is on its way
      server.release();
      await settle();
      expect(composer().prompt.disabled).toBe(true); // and now it is full
    });

    it('a new conversation from the popup starts with room again', async () => {
      await boot({ config: { max_user_prompts: 3 } });
      expect(composer().prompt.disabled).toBe(true);
      newChat();
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(text(composer().hint)).toContain('0 of 10 prompts'); // the mock new conversation reports the default limit
      expect(composer().prompt.disabled).toBe(false);
    });

    it('offers no limit text when the server sends none', async () => {
      await boot({ config: { max_user_prompts: undefined } });
      expect(text(composer().hint)).toBe('Replay it on another model to compare.');
      expect(composer().prompt.disabled).toBe(false);
    });

    it('is not stopped by a conversation that still has room after many turns', async () => {
      const many = Array.from({ length: 5 }, (_, i) => [msg(i * 2 + 1, 'user', `q${i}`), msg(i * 2 + 2, 'assistant', `a${i}`)]).flat();
      await boot({ messages: many, isSample: false, config: { max_user_prompts: 10 } });
      expect(text(composer().hint)).toContain('5 of 10 prompts');
    });
  });

  describe('File > Open', () => {
    const other = (extra = {}) => ({
      conversation_id: 'c9', is_sample: false, name: 'Earlier chat', agent_id: 'research', model: 'model-b', reasoning_level: 'high',
      kb_summary_tool: true, source_conversation_id: null, created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-02T00:00:00Z',
      prompt_count: 1, messages: [msg(1, 'user', 'an older question'), msg(2, 'assistant', 'an older answer')], ...extra,
    }); // fmt: skip
    const options = () => [...document.querySelectorAll('.chat-option')];

    it('lists the chats with their settings and prompt counts, the current one marked and selected', async () => {
      const { server } = await boot();
      server.otherChats = [other()];
      await openChat();
      expect(modal().querySelector('h2').textContent).toBe('Open a chat');
      expect(options()).toHaveLength(2);
      expect(options()[0].textContent).toContain('Sample conversation');
      expect(options()[0].textContent).toContain('Open now');
      expect(options()[0].textContent).toContain('3 prompts');
      expect(options()[1].textContent).toContain('Earlier chat');
      expect(options()[1].textContent).toContain('IT Security Assistant · model-b · 1 prompt ·');
      expect(modal().querySelector('input[name="chat"]:checked').value).toBe('c1');
      expect(modal().textContent).toContain('Replays are not listed here');
    });

    it('opens the chosen chat with its messages and fixed settings', async () => {
      const { server, mock } = await boot();
      server.otherChats = [other()];
      await openChat();
      modal().querySelector('input[value="c9"]').click();
      modal().querySelector('button[type="submit"]').click();
      await settle();
      expect(mock.called('POST /api/conversations/:id/open')).toBe(true);
      expect(modal()).toBeNull();
      expect($('conversation-name').textContent).toBe('Earlier chat');
      expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-b', REASONING: 'High', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On', 'BRIEF REPLIES': 'Off' });
      expect(document.querySelectorAll('.message')).toHaveLength(2);
      submit('continuing the earlier chat');
      await settle();
      expect(mock.calls.at(-1).path).toContain('/c9/');
    });

    it('choosing the chat that is already open just closes the popup', async () => {
      const { server, mock } = await boot();
      server.otherChats = [other()];
      await openChat();
      modal().querySelector('button[type="submit"]').click();
      await settle();
      expect(modal()).toBeNull();
      expect(mock.called('POST /api/conversations/:id/open')).toBe(false);
    });

    it('says so when a chat cannot be opened, and keeps the popup open', async () => {
      const { server } = await boot();
      server.otherChats = [other()];
      await openChat();
      server.otherChats = [];
      modal().querySelector('input[value="c9"]').click();
      modal().querySelector('button[type="submit"]').click();
      await settle();
      expect(modal().querySelector('.modal-error').textContent).toBe('Conversation not found.');
      expect($('conversation-name').textContent).toBe('Sample conversation');
    });

    it('shows an error toast when the list cannot be loaded', async () => {
      const { server } = await boot();
      server.failList = apiError(500, 'oops', 'The server hit a problem.');
      await openChat();
      expect(modal()).toBeNull();
      expect(toastText()).toContain('The server hit a problem.');
    });

    it('does nothing while a reply is on its way', async () => {
      const { server, mock } = await boot();
      server.hold = true;
      submit('a slow one');
      await settle();
      await openChat();
      expect(modal()).toBeNull();
      expect(mock.called('GET /api/conversations')).toBe(false);
      server.release();
    });
  });

  it('refuses a temperature outside 0 to 2 and keeps the popup open', async () => {
    const { mock } = await boot();
    for (const bad of ['', '2.5', '-1', 'hot']) {
      newChat();
      field('temperature').value = bad;
      modal().querySelector('form').requestSubmit();
      await settle();
      expect(modal().querySelector('.modal-error').textContent).toBe('Temperature must be a number from 0 to 2.');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
    expect(mock.called('POST /api/conversations')).toBe(false);
  });

  it('"Use this chat\'s settings" copies the temperature too', async () => {
    const { mock } = await boot({ config: { temperature: 1.3 } });
    newChat();
    modal().querySelector('#use-chat-settings').click();
    expect(field('temperature').value).toBe('1.3');
    modal().querySelector('form').requestSubmit();
    await settle();
    expect(mock.lastBody('POST /api/conversations').temperature).toBe(1.3);
  });

  it('shows the temperature chip, and 0 when the server sends none', async () => {
    await boot({ config: { temperature: 0.4 } });
    expect(chips().TEMPERATURE).toBe('0.4');
  });

  it('closing the popup (Escape, Cancel or the backdrop) starts nothing', async () => {
    const { mock } = await boot();
    newChat();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal()).toBeNull();
    newChat();
    modal().querySelector('.modal-actions .btn').click(); // Cancel
    expect(modal()).toBeNull();
    newChat();
    document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(modal()).toBeNull();
    expect(mock.called('POST /api/conversations')).toBe(false);
    expect($('conversation-name').textContent).toBe('Sample conversation');
  });

  it('keeps the popup open and says why when the server refuses', async () => {
    const { server } = await boot();
    server.failCreate = apiError(422, 'validation_error', 'Unknown model: model-z.');
    newChat();
    modal().querySelector('form').requestSubmit();
    await settle();
    expect(modal()).not.toBeNull();
    expect(modal().querySelector('.modal-error').textContent).toBe('Unknown model: model-z.');
    expect($('conversation-name').textContent).toBe('Sample conversation');
  });

  it('"Use this chat\'s settings" fills the popup so another conversation can be compared', async () => {
    await boot({ config: { name: 'Network design', agent_id: 'code', model: 'model-c', reasoning_level: 'low', kb_summary_tool: true } });
    newChat();
    expect(field('agent').value).toBe('assistant');
    modal().querySelector('#use-chat-settings').click();
    expect(field('name').value).toBe('Network design 2');
    expect(field('agent').value).toBe('code');
    expect(field('model').value).toBe('model-c');
    expect(field('reasoning').value).toBe('low');
    expect(field('kbsummary').checked).toBe(true);
  });

  it('renames the conversation (a label) and nothing else', async () => {
    const { mock } = await boot({ config: { reasoning_level: 'medium' } });
    $('rename-chat').click();
    expect(modal().querySelector('h2').textContent).toBe('Rename conversation');
    field('name').value = '  Better name ';
    modal().querySelector('form').requestSubmit();
    await settle();
    expect(mock.lastBody('PATCH /api/conversations/:id')).toEqual({ name: '  Better name ' });
    expect($('conversation-name').textContent).toBe('Better name');
    expect(chips().REASONING).toBe('Medium');
    expect(modal()).toBeNull();
  });

  it('Compact starts a new conversation from a summary and keeps the settings', async () => {
    const { mock } = await boot({ messages: sample(), isSample: false, config: { name: 'Design', model: 'model-b', reasoning_level: 'high' } });
    expect($('compact-chat').disabled).toBe(false);
    $('compact-chat').click();
    await settle();
    expect(mock.called('POST /api/conversations/:id/compact')).toBe(true);
    expect($('conversation-name').textContent).toBe('Design (summary)');
    expect(chips().MODEL).toBe('model-b');
    expect(chips().REASONING).toBe('High');
    expect(messageEls()).toHaveLength(1);
    expect(messageEls()[0].textContent).toContain('Summary of an earlier conversation');
    expect(messageEls()[0].textContent).toContain('SUMMARY OF THE EARLIER CONVERSATION');
    expect(toastText()).toContain('Started a new conversation from a summary');
    expect($('compact-chat').disabled).toBe(true); // nothing answered yet in the new conversation
    submit('continue from the summary');
    await settle();
    expect(mock.calls.at(-1).path).toContain('/c3/');
  });

  it('Compact is disabled until a prompt has been answered', async () => {
    await boot({ messages: [], isSample: false });
    expect($('compact-chat').disabled).toBe(true);
  });

  it('Compact shows the server message when it fails and stays in the same conversation', async () => {
    const { server } = await boot({ messages: sample(), isSample: false });
    server.failCompact = apiError(502, 'llm_http_error', 'API returned HTTP 400: model rejected it');
    $('compact-chat').click();
    await settle();
    expect(toastText()).toBe('API returned HTTP 400: model rejected it');
    expect($('compact-chat').disabled).toBe(false);
    expect(messageEls()).toHaveLength(6);
  });

  it('shows the summary that was sent instead of the file, and flags a deleted file version', async () => {
    await boot({
      messages: [
        msg(1, 'user', 'How do I segment my network?', { request_id: 'req-1-aaaaaa' }),
        msg(2, 'assistant', 'Segment by trust level.', { kb_summary: 'Segment by trust level, then monitor.', kb_version_deleted: true }),
        msg(3, 'user', 'Thanks'),
        msg(4, 'assistant', 'You are welcome.'),
      ],
    });
    const first = messageEls()[1];
    expect(first.querySelector('.kb-summary summary').textContent).toContain('KB summary');
    expect(first.querySelector('.kb-summary').open).toBe(false);
    expect(first.querySelector('.kb-summary-text').textContent).toBe('Segment by trust level, then monitor.');
    expect(first.querySelector('.kb-deleted-flag').textContent).toContain('has been deleted');
    expect(messageEls()[3].querySelector('.kb-summary')).toBeNull();
    expect(messageEls()[3].querySelector('.kb-deleted-flag')).toBeNull();
  });

  it('remembers hiding the conversation sidebar on the server', async () => {
    const { mock } = await boot();
    $('hide-conversation').click();
    await settle();
    expect(mock.lastBody('PUT /api/preferences')).toEqual({ chat_sidebar_hidden: true });
    expect($('chat-layout').classList.contains('conversation-hidden')).toBe(true);
  });

  it('shows a retryable error when the conversation cannot be loaded', async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    setUnauthorizedHandler(vi.fn());
    const { routes } = appRoutes();
    mockApi({ ...routes, 'GET /api/conversations/current': apiError(500, 'oops', 'The server hit a problem.') });
    await import('./chat-controller.js');
    await settle();
    expect(document.querySelector('[role="alert"]').textContent).toContain('The server hit a problem.');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '../../shared/http.js';
import { apiError, appRoutes, created, mockApi, settle } from '../../test/mock-api.js';

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
function chatServer({ appOverrides = {}, messages = sample(), isSample = true, failSend = null, config = {} } = {}) {
  const { state: app, routes } = appRoutes(appOverrides);
  const server = {
    app,
    conversation: {
      conversation_id: 'c1', is_sample: isSample, name: 'Sample conversation', agent_id: 'assistant', model: 'model-a',
      reasoning_level: 'default', kb_summary_tool: false, source_conversation_id: null, created_at: '2026-01-01T00:00:00Z', max_user_prompts: 10, messages,
      ...config,
    }, // fmt: skip
    hold: false,
    failRefresh: false,
    order: [],
    release: () => {},
  };
  let next = 100;
  const send = async ({ body, params, signal }) => {
    server.order.push('send');
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
    'POST /api/conversations/:id/rewind': () => {
      const i = server.conversation.messages.findLastIndex((m) => m.role === 'user');
      if (i < 0) return apiError(409, 'nothing_to_rewind', 'There is no prompt to rewind.');
      const [removed] = server.conversation.messages.splice(i);
      server.conversation.is_sample = false;
      return { messages: structuredClone(server.conversation.messages), removed_prompt: removed.content };
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

async function boot(options) {
  vi.resetModules();
  document.body.innerHTML = '';
  setUnauthorizedHandler(vi.fn());
  const fake = chatServer(options);
  await import('./chat-controller.js');
  await settle();
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
  Object.fromEntries([...document.querySelectorAll('.config-chips .chip')].map((c) => [c.querySelector('b').textContent.toUpperCase(), c.childNodes[1].textContent]));
const modal = () => document.querySelector('.modal');
const field = (name) => modal().elements?.[name] ?? modal().querySelector(`[name="${name}"]`);
const messageCopies = () => [...document.querySelectorAll('.message-copy')].map((e) => e.textContent);

describe('chat page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the conversation, agents and models from the server', async () => {
    await boot();
    expect(document.querySelectorAll('.message')).toHaveLength(6);
    expect(document.querySelector('.badge').textContent).toBe('3 turns');
    expect($('conversation-name').textContent).toBe('Sample conversation');
    expect(chips()).toEqual({ AGENT: 'General assistant', MODEL: 'model-a', REASONING: 'Default (model decides)', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'Off' });
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
    expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-b', REASONING: 'High', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On' });
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

  it('rewinds: the last prompt goes back into the composer', async () => {
    const { server, mock } = await boot();
    $('rewind').click();
    await settle();
    expect(mock.called('POST /api/conversations/:id/rewind')).toBe(true);
    expect($('prompt').value).toBe('Can you turn that into a short project brief?');
    expect(document.querySelectorAll('.message')).toHaveLength(4);
    expect(server.conversation.messages).toHaveLength(4);
    expect(toastText()).toBe('Stepped back one turn. Edit your prompt and try again.');
  });

  it('shows the server message when there is nothing to rewind', async () => {
    const { server } = await boot({ messages: [], isSample: false });
    server.conversation.messages = [];
    $('rewind').disabled = false;
    $('rewind').click();
    await settle();
    expect(toastText()).toBe('There is no prompt to rewind.');
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
    expect(field('temperature').value).toBe('0'); // 0 by default
    expect(mock.called('POST /api/conversations')).toBe(false); // nothing starts until the popup is submitted
    field('name').value = 'Segmentation, high';
    field('agent').value = 'research';
    field('model').value = 'model-b';
    field('reasoning').value = 'high';
    field('temperature').value = '0.7';
    field('kbsummary').checked = true;
    modal().querySelector('form').requestSubmit();
    await settle();
    expect(mock.lastBody('POST /api/conversations')).toEqual({
      name: 'Segmentation, high', agent_id: 'research', model: 'model-b', reasoning_level: 'high', temperature: 0.7, kb_summary_tool: true,
    }); // fmt: skip
    expect(modal()).toBeNull();
    expect($('conversation-name').textContent).toBe('Segmentation, high');
    expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-b', REASONING: 'High', TEMPERATURE: '0.7', 'KB SUMMARY TOOL': 'On' });
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

    it('offers each API\'s models as "label · model", with the label-qualified choice as the value', async () => {
      await boot({ appOverrides: APPS, config: { model: 'H100::llama' } });
      newChat();
      const options = [...field('model').options];
      expect(options.map((o) => o.textContent)).toEqual(['H100 · llama', 'A100 · llama', 'A100 · mixtral']); // the same name on two APIs reads as two choices
      expect(options.map((o) => o.value)).toEqual(['H100::llama', 'A100::llama', 'A100::mixtral']);
    });

    it('starts the conversation on the chosen API\'s model and shows it as label · model', async () => {
      const { mock } = await boot({ appOverrides: APPS, config: { model: 'H100::llama' } });
      newChat();
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
      expect(text(hint)).toBe('3 of 3 prompts: this conversation is full. Start a new one with File > New, or Rewind to step back.');
      expect(hint.classList.contains('full')).toBe(true);
      expect($('chat-form').dataset.full).toBe('true');
      expect($('rewind').disabled).toBe(false); // stepping back frees a slot
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

    it('opens the composer again after Rewind frees a slot', async () => {
      await boot({ config: { max_user_prompts: 3 } });
      expect(composer().prompt.disabled).toBe(true);
      $('rewind').click();
      await settle();
      expect(text(composer().hint)).toContain('2 of 3 prompts');
      expect(composer().prompt.disabled).toBe(false);
      expect(composer().prompt.value).toBe('Can you turn that into a short project brief?'); // the stepped-back prompt, ready to edit
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
      expect(chips()).toEqual({ AGENT: 'IT Security Assistant', MODEL: 'model-b', REASONING: 'High', TEMPERATURE: '0', 'KB SUMMARY TOOL': 'On' });
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

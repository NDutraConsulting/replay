import { beforeEach, describe, expect, it } from 'vitest';
import { CALL_HEADING, apiCallHTML, apiLogHTML, callDiffText, callSettings, compactJson, openApiLogModal, prettyBody, purposeLabel } from './api-log-ui.js';

const call = (extra = {}) => ({
  at: '2026-01-01T00:00:00Z', purpose: 'answer', method: 'POST', url: 'https://api.openai.com/v1/chat/completions', duration_ms: 412,
  request: { headers: { Authorization: 'Bearer <redacted>', 'Content-Type': 'application/json' }, body: { model: 'gpt-x', messages: [{ role: 'user', content: 'hi <b>' }], temperature: 0 } },
  response: { status: 200, body: '{"choices":[{"message":{"content":"hello"}}]}', truncated: false }, error: null, ...extra,
}); // fmt: skip
const log = (turns, extra = {}) => ({ id: 'r1:a', recorded: true, model: 'gpt-x', turns, ...extra });
const turn = (n, calls, prompt = `prompt ${n}`) => ({ turn_index: n, prompt, calls });

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('purposeLabel', () => {
  it('names what each call was for', () => {
    expect(purposeLabel('answer')).toBe('Answer');
    expect(purposeLabel('kb_summary')).toBe('KB summary');
    expect(purposeLabel('compact_summary')).toBe('Compact summary');
    expect(purposeLabel('kb_route:subcategory')).toBe('KB routing · Sub category');
    expect(purposeLabel('kb_route:weird')).toBe('KB routing · weird');
    expect(purposeLabel('other')).toBe('other');
  });
});

describe('prettyBody', () => {
  it('indents JSON and leaves anything else as it is', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('not json <b>')).toBe('not json <b>');
    expect(prettyBody(undefined)).toBe('');
  });
});

const settings = (extra = {}) => ({ temperature: 0, temperature_sent: true, temperature_note: null, reasoning_effort: null, ...extra });

describe('what a call carried', () => {
  it('lists a sent temperature and reasoning effort, on the summary and in the body', () => {
    document.body.innerHTML = apiCallHTML(call({ settings: settings({ temperature: 0.4, reasoning_effort: 'high' }), request: { headers: {}, body: { model: 'x', temperature: 0.4, reasoning_effort: 'high' } } }), 0);
    expect([...document.querySelectorAll('.api-chips .chip')].map((c) => c.textContent)).toEqual(['Temperature 0.4', 'Reasoning high', 'Log probs off']);
    const lines = [...document.querySelectorAll('.api-settings li')].map((li) => li.textContent);
    expect(lines).toEqual(['Temperature 0.4 (sent)', 'Reasoning effort high (sent as reasoning_effort)', 'Log probabilities off for this replay']);
  });

  it('names the rule that shaped the request and what it changed', () => {
    const rule = settings({ temperature_sent: false, temperature_note: 'gpt-6-luna accepts a temperature only when the reasoning level is None.', rule: 'gpt-6-luna', adjustments: ['gpt-6-luna accepts a temperature only when the reasoning level is None.', 'Reasoning effort high was not sent: x.'] });
    document.body.innerHTML = apiCallHTML(call({ settings: rule }), 0);
    const lines = [...document.querySelectorAll('.api-settings li')].map((li) => li.textContent);
    expect(lines).toContain('Request rules gpt-6-luna');
    expect(lines).toContain('Adjusted Reasoning effort high was not sent: x.');
    expect(lines.filter((l) => l.includes('accepts a temperature only'))).toHaveLength(1); // the temperature reason is not repeated
    document.body.innerHTML = apiCallHTML(call({ settings: settings({ rule: 'unknown' }) }), 0);
    expect(document.querySelector('.api-settings').textContent).toContain('Request rules none for this model: sent as chosen');
    document.body.innerHTML = apiCallHTML(call({ settings: null }), 0);
    expect(document.querySelector('.api-settings').textContent).not.toContain('Request rules'); // an older call has none
  });

  it('says log probabilities were requested, and that they are in the response', () => {
    const asked = settings({ logprobs: true, logprobs_sent: true });
    document.body.innerHTML = apiCallHTML(call({ settings: asked, request: { headers: {}, body: { model: 'x', logprobs: true } } }), 0);
    expect([...document.querySelectorAll('.api-chips .chip')].map((c) => c.textContent)).toContain('Log probs requested');
    expect([...document.querySelectorAll('.api-settings li')].map((li) => li.textContent)).toContain('Log probabilities requested (logprobs: true); they are in the response below');
  });

  it('says log probabilities that were asked for but not requested, and why', () => {
    const s = callSettings(call({ settings: settings({ logprobs: true, logprobs_sent: false, logprobs_note: 'gpt-6-luna accepts log probabilities only when the reasoning level is None.' }) }));
    expect(s.logprobs.chip).toBe('Log probs not requested');
    expect(s.logprobs.text).toBe('asked for, but not requested. gpt-6-luna accepts log probabilities only when the reasoning level is None.');
    document.body.innerHTML = apiCallHTML(call({ settings: settings({ logprobs: true, logprobs_sent: false, logprobs_note: 'because' }) }), 0);
    expect([...document.querySelectorAll('.api-settings li')].filter((li) => li.textContent.includes('because'))).toHaveLength(1); // not repeated under Adjusted
  });

  it('reads log probabilities of an older call from its request body, and shows "off" for a call that did not ask', () => {
    expect(callSettings(call({ settings: null, request: { headers: {}, body: { logprobs: true } } })).logprobs.chip).toBe('Log probs requested');
    expect(callSettings(call({ settings: null, request: { headers: {}, body: {} } })).logprobs).toEqual({ chip: 'Log probs off', text: 'not in this request' });
    expect(callSettings(call({ settings: settings() })).logprobs).toEqual({ chip: 'Log probs off', text: 'off for this replay' });
  });

  it('says a default reasoning level was left out, so the model decides', () => {
    expect(callSettings(call({ settings: settings() })).reasoning).toEqual({
      chip: 'Reasoning default', text: 'default (reasoning_effort was left out, so the model decides)',
    }); // fmt: skip
  });

  it('says a temperature that was set but not sent, and why', () => {
    const s = callSettings(call({ settings: settings({ temperature_sent: false, temperature_note: 'This model refused a temperature earlier, so it is left out.' }) }));
    expect(s.temperature.chip).toBe('Temperature 0 not sent');
    expect(s.temperature.text).toBe('0 was set, but it was not sent. This model refused a temperature earlier, so it is left out.');
  });

  it('says a call that uses no temperature (knowledge-base routing) does not use it', () => {
    const s = callSettings(call({ settings: settings({ temperature: null, temperature_sent: false }) }));
    expect(s.temperature.chip).toBe('Temperature not used');
  });

  it('reads an older call, logged without settings, from its request body', () => {
    expect(callSettings(call({ settings: null, request: { headers: {}, body: { temperature: 0 } } })).temperature.chip).toBe('Temperature 0');
    expect(callSettings(call({ settings: undefined, request: { headers: {}, body: { reasoning_effort: 'low' } } })).reasoning.chip).toBe('Reasoning low');
    expect(callSettings(call({ settings: null, request: { headers: {}, body: {} } })).temperature).toEqual({ chip: 'Temperature not sent', text: 'not in this request' });
  });

  it('names the replay\'s own temperature and reasoning level above the calls', () => {
    document.body.innerHTML = apiLogHTML(log([turn(0, [call()])], { temperature: 0, reasoning_level: 'default' }));
    expect([...document.querySelectorAll('.api-settings-line .chip')].map((c) => c.textContent)).toEqual(['Replay temperature0', 'Replay reasoningDefault (model decides)', 'Replay log probsOff']);
    document.body.innerHTML = apiLogHTML(log([turn(0, [call()])], { temperature: 1.2, reasoning_level: 'xhigh', logprobs: true }));
    expect(document.querySelector('.api-settings-line').textContent).toContain('Replay log probsOn');
    expect(document.querySelector('.api-settings-line').textContent).toContain('1.2');
    expect(document.querySelector('.api-settings-line').textContent).toContain('Extra high');
  });
});

describe('one REST call', () => {
  it('is a collapsible, closed, whose summary names the method, URL, status, purpose and time', () => {
    document.body.innerHTML = apiCallHTML(call(), 0);
    const box = document.querySelector('details.api-call');
    expect(box.open).toBe(false);
    const summary = box.querySelector('summary').textContent;
    expect(summary).toContain('POST');
    expect(summary).toContain('https://api.openai.com/v1/chat/completions');
    expect(summary).toContain('200');
    expect(summary).toContain('Answer · 412 ms');
    expect(box.querySelector('.api-status').classList.contains('ok')).toBe(true);
  });

  it('shows the request URL, the headers, the body, and the response, escaped', () => {
    document.body.innerHTML = apiCallHTML(call(), 0);
    const pres = [...document.querySelectorAll('.api-pre')].map((p) => p.textContent);
    expect(pres[0]).toBe('POST https://api.openai.com/v1/chat/completions');
    expect(pres[1]).toContain('Authorization: Bearer <redacted>');
    expect(pres[2]).toContain('"temperature": 0');
    expect(pres[2]).toContain('hi <b>');
    expect(pres[3]).toContain('"content": "hello"'); // the response, indented
    expect(document.querySelector('.api-call-body .api-pre b')).toBeNull(); // nothing from the data became markup
  });

  it('marks an error status and shows its body', () => {
    document.body.innerHTML = apiCallHTML(call({ response: { status: 400, body: '{"error":{"message":"nope"}}', truncated: false } }), 0);
    expect(document.querySelector('.api-status').classList.contains('bad')).toBe(true);
    expect(document.querySelector('.api-call-body').textContent).toContain('"message": "nope"');
  });

  it('says so when there was no response, and when the body was cut', () => {
    document.body.innerHTML = apiCallHTML(call({ response: null, error: 'The API did not respond in time.' }), 0);
    expect(document.querySelector('.api-status').textContent).toBe('No response');
    expect(document.querySelector('.api-error').textContent).toBe('The API did not respond in time.');
    document.body.innerHTML = apiCallHTML(call({ response: { status: 200, body: 'xxxx', truncated: true } }), 0);
    expect(document.body.textContent).toContain('cut here');
  });
});

describe('the whole log', () => {
  it('gives every call its own collapsible, grouped under its prompt, numbered in order', () => {
    document.body.innerHTML = apiLogHTML(log([turn(0, [call({ purpose: 'kb_route:category' }), call({ purpose: 'kb_route:file' }), call()]), turn(1, [call()])]));
    expect(document.querySelectorAll('details.api-call')).toHaveLength(4);
    expect([...document.querySelectorAll('.api-turn h3')].map((h) => h.textContent)).toEqual(['Prompt 01 3 calls', 'Prompt 02 1 call']);
    expect([...document.querySelectorAll('.api-index')].map((e) => e.textContent)).toEqual(['#1', '#2', '#3', '#4']);
    expect(document.querySelector('.modal-text').textContent).toContain('4 REST calls to the provider for gpt-x');
    expect(document.querySelector('.modal-text').textContent).toContain('never stored');
  });

  it('shows the prompt as text', () => {
    document.body.innerHTML = apiLogHTML(log([turn(0, [call()], 'plan <i>it</i>')]));
    expect(document.querySelector('.api-prompt').textContent).toBe('plan <i>it</i>');
    expect(document.querySelector('.api-prompt i')).toBeNull();
  });

  it('explains an empty log: demo mode, or a replay saved before logs existed', () => {
    expect(apiLogHTML(log([turn(0, [])]))).toContain('demo mode');
    expect(apiLogHTML(log([turn(0, [])], { recorded: false }))).toContain('saved before API logs existed');
  });
});

describe('the popup', () => {
  it('opens with the title and the log, and closes with its button', async () => {
    openApiLogModal(log([turn(0, [call()])]), 'API log · A · gpt-x');
    expect(document.querySelector('.modal.api-log-modal h2').textContent).toBe('API log · A · gpt-x');
    expect(document.querySelectorAll('.modal details.api-call')).toHaveLength(1);
    document.querySelector('.modal button[type="submit"]').click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.querySelector('.modal')).toBeNull();
  });
});

describe('a call as comparable text', () => {
  it('holds the settings, the request and the response under headings, and leaves out the time', () => {
    const text = callDiffText(call({ settings: { temperature: 0, temperature_sent: true, temperature_note: null, logprobs: false, logprobs_sent: false, logprobs_note: null, reasoning_effort: null, rule: 'gpt-6-luna', adjustments: [] } }));
    const lines = text.split('\n');
    expect(lines.filter((l) => !l.startsWith(' '))).toEqual(['Settings', 'Request', 'Response']);
    expect(CALL_HEADING.test('Settings') && CALL_HEADING.test('Request') && CALL_HEADING.test('Response')).toBe(true);
    expect(CALL_HEADING.test('  Request')).toBe(false);
    expect(text).toContain('  Temperature: 0 (sent)');
    expect(text).toContain('  Request rules: gpt-6-luna');
    expect(text).toContain('  POST https://api.openai.com/v1/chat/completions');
    expect(text).toContain('  Authorization: Bearer <redacted>');
    expect(text).toContain('  Status 200');
    expect(text).toContain('      "content": "hello"'); // the response body, indented
    expect(text).not.toContain('412'); // the duration would differ every time
  });

  it('lists what the rules changed, once, and says when a response was cut or missing', () => {
    const note = 'gpt-6-luna accepts a temperature only when the reasoning level is None.';
    const adjusted = callDiffText(call({ settings: { temperature: 0, temperature_sent: false, temperature_note: note, reasoning_effort: null, rule: 'gpt-6-luna', adjustments: [note, 'Reasoning effort high was not sent: x.'] } }));
    expect(adjusted.split(note).length - 1).toBe(1); // the temperature reason is already under Temperature
    expect(adjusted).toContain('  Adjusted: Reasoning effort high was not sent: x.');
    expect(callDiffText(call({ response: { status: 200, body: '{}', truncated: true } }))).toContain('(cut: the log keeps only the start of a long response)');
    expect(callDiffText(call({ response: null, error: 'The API did not respond in time.' }))).toContain('  No response: The API did not respond in time.');
  });

  it('is empty for a call that was not made', () => {
    expect(callDiffText(undefined)).toBe('');
    expect(callDiffText(null)).toBe('');
  });

  it('keeps one token per line in a log prob list, and anything that is not JSON as it is', () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'Hi' }, logprobs: { content: [{ token: 'H', logprob: -0.1, bytes: [72], top_logprobs: [] }, { token: 'i', logprob: -2, bytes: [105], top_logprobs: [] }] } }] });
    const compact = compactJson(body);
    expect(compact.split('\n').filter((l) => l.includes('"token"'))).toEqual(['          {"token":"H","logprob":-0.1,"bytes":[72],"top_logprobs":[]},', '          {"token":"i","logprob":-2,"bytes":[105],"top_logprobs":[]}']);
    expect(JSON.parse(compact).choices[0].message.content).toBe('Hi'); // still valid JSON
    expect(compactJson('plain <text>')).toBe('plain <text>');
    expect(compactJson(undefined)).toBe('');
  });
});

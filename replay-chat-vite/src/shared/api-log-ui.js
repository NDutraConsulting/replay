import { esc } from './html.js';
import { modelLabel } from './model-label.js';
import { showModal } from './modal-ui.js';
import { reasoningLabel } from './reasoning.js';
import { temperatureLabel } from './temperature.js';

/** What each logged call was for, in words. */
export function purposeLabel(purpose) {
  if (purpose === 'answer') return 'Answer';
  if (purpose === 'kb_summary') return 'KB summary';
  if (purpose === 'compact_summary') return 'Compact summary';
  if (typeof purpose === 'string' && purpose.startsWith('kb_route:')) {
    const level = purpose.slice('kb_route:'.length);
    return `KB routing · ${{ category: 'Category', subcategory: 'Sub category', file: 'File' }[level] ?? level}`;
  }
  return purpose || 'Call';
}

/** JSON text indented for reading; anything that is not JSON is shown exactly as it is. */
export function prettyBody(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return String(text ?? '');
  }
}

/**
 * What a call carried, in words: the temperature and the reasoning effort. `call.settings` is what the server recorded; a
 * call logged before that was kept is read from its request body instead (a field missing there was not sent).
 * Returns { temperature: {chip, text}, reasoning: {chip, text} }.
 */
export function callSettings(call) {
  const body = call.request?.body ?? {};
  const s = call.settings;
  const sentTemperature = s ? s.temperature_sent : 'temperature' in body;
  const temperature = s ? s.temperature : (body.temperature ?? null);
  const effort = s ? s.reasoning_effort : (body.reasoning_effort ?? null);
  let temp;
  if (sentTemperature) {
    const value = temperatureLabel(body.temperature ?? temperature);
    temp = { chip: `Temperature ${value}`, text: `${value} (sent)` };
  } else if (s && temperature !== null) {
    temp = { chip: `Temperature ${temperatureLabel(temperature)} not sent`, text: `${temperatureLabel(temperature)} was set, but it was not sent. ${s.temperature_note || ''}`.trim() };
  } else if (s) {
    temp = { chip: 'Temperature not used', text: 'not used for this call (it makes no use of the temperature setting)' };
  } else {
    temp = { chip: 'Temperature not sent', text: 'not in this request' };
  }
  const reasoning = effort
    ? { chip: `Reasoning ${effort}`, text: `${effort} (sent as reasoning_effort)` }
    : { chip: 'Reasoning default', text: 'default (reasoning_effort was left out, so the model decides)' };
  const askedLogprobs = s ? s.logprobs : 'logprobs' in body;
  const sentLogprobs = s ? s.logprobs_sent : 'logprobs' in body;
  let logprobs;
  if (sentLogprobs) logprobs = { chip: 'Log probs requested', text: 'requested (logprobs: true); they are in the response below' };
  else if (askedLogprobs) logprobs = { chip: 'Log probs not requested', text: `asked for, but not requested. ${s?.logprobs_note || ''}`.trim() };
  else logprobs = { chip: 'Log probs off', text: s ? 'off for this replay' : 'not in this request' };
  return { temperature: temp, reasoning, logprobs };
}

/** The headings of `callDiffText`: the Diff styles these lines as headings. */
export const CALL_HEADING = /^(Settings|Request|Response)$/;

/**
 * One call as plain, indented text, so two calls can be compared line by line (the Diff's API logs view). It holds what
 * the call was set to, the request (line, headers, JSON body) and the response (status and body); the time it took is
 * left out because it would differ every time. A log prob list is written one token per line instead of one field per line.
 */
export function callDiffText(call) {
  if (!call) return '';
  const s = callSettings(call);
  const info = call.settings;
  const indent = (text) => String(text).split('\n').map((l) => `  ${l}`).join('\n');
  const settings = [`Temperature: ${s.temperature.text}`, `Reasoning effort: ${s.reasoning.text}`, `Log probabilities: ${s.logprobs.text}`];
  if (info?.rule) settings.push(`Request rules: ${info.rule === 'unknown' ? 'none for this model: sent as chosen' : info.rule}`);
  for (const note of (info?.adjustments ?? []).filter((a) => a !== info.temperature_note && a !== info.logprobs_note)) settings.push(`Adjusted: ${note}`);
  const res = call.response;
  return [
    'Settings', indent(settings.join('\n')),
    'Request', indent(`${call.method} ${call.url}\n${headersText(call.request?.headers)}\n${compactJson(JSON.stringify(call.request?.body ?? {}))}`),
    'Response', indent(res ? `Status ${res.status}\n${compactJson(res.body)}${res.truncated ? '\n(cut: the log keeps only the start of a long response)' : ''}` : `No response: ${call.error || 'the API did not answer.'}`),
  ].join('\n'); // fmt: skip
}

/** Pretty JSON for a line-by-line comparison; each token of a log prob list stays on one line. Not JSON: shown as it is. */
export function compactJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return String(text ?? '');
  }
  const lines = [];
  for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
    const content = choice?.logprobs?.content;
    if (Array.isArray(content)) choice.logprobs.content = content.map((t) => `@@token${lines.push(JSON.stringify(t)) - 1}@@`);
  }
  return JSON.stringify(data, null, 2).replace(/"@@token(\d+)@@"/g, (_, i) => lines[Number(i)]);
}

const headersText = (headers) =>
  Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

/** One REST call as its own collapsible: the summary names it (method, URL, status), the body holds request and response. */
export function apiCallHTML(call, index) {
  const res = call.response;
  const ok = res && res.status >= 200 && res.status < 300;
  const status = res ? `<span class="badge api-status ${ok ? 'ok' : 'bad'}">${esc(res.status)}</span>` : '<span class="badge api-status bad">No response</span>';
  const request = JSON.stringify(call.request?.body ?? {}, null, 2);
  const settings = callSettings(call);
  const s = call.settings;
  const adjusted = (s?.adjustments ?? []).filter((a) => a !== s.temperature_note && a !== s.logprobs_note); // those reasons are already above
  const extras = `${s?.rule ? `<li><b>Request rules</b> ${esc(s.rule === 'unknown' ? 'none for this model: sent as chosen' : s.rule)}</li>` : ''}${adjusted.map((a) => `<li><b>Adjusted</b> ${esc(a)}</li>`).join('')}`;
  return `<details class="api-call"><summary><span class="api-index">#${index + 1}</span><span class="api-method">${esc(call.method)}</span><span class="api-url">${esc(call.url)}</span>${status}<span class="api-purpose">${esc(purposeLabel(call.purpose))} · ${esc(call.duration_ms)} ms</span><span class="api-chips"><span class="chip">${esc(settings.temperature.chip)}</span><span class="chip">${esc(settings.reasoning.chip)}</span><span class="chip">${esc(settings.logprobs.chip)}</span></span></summary><div class="api-call-body"><h4>Settings</h4><ul class="api-settings"><li><b>Temperature</b> ${esc(settings.temperature.text)}</li><li><b>Reasoning effort</b> ${esc(settings.reasoning.text)}</li><li><b>Log probabilities</b> ${esc(settings.logprobs.text)}</li>${extras}</ul><h4>Request</h4><pre class="api-pre api-line">${esc(call.method)} ${esc(call.url)}</pre><div class="api-label">Headers</div><pre class="api-pre">${esc(headersText(call.request?.headers))}</pre><div class="api-label">Body</div><pre class="api-pre">${esc(request)}</pre><h4>Response</h4>${res ? `<div class="api-label">Status ${esc(res.status)}</div><pre class="api-pre">${esc(prettyBody(res.body))}</pre>${res.truncated ? '<p class="small">This response was longer than the log keeps, so it is cut here. The answer itself was used whole.</p>' : ''}` : `<p class="api-error">${esc(call.error || 'The API did not answer.')}</p>`}</div></details>`;
}

/** The whole log: every prompt with its calls, or the reason there is nothing to show. */
export function apiLogHTML(log) {
  if (!log.recorded) {
    return '<p class="modal-text">No API log was kept for this replay. It was saved before API logs existed.</p>';
  }
  const calls = log.turns.reduce((n, t) => n + t.calls.length, 0);
  if (!calls) {
    return '<p class="modal-text">No API calls were made. This replay ran in demo mode, so nothing was sent to the provider.</p>';
  }
  const sections = log.turns
    .filter((t) => t.calls.length)
    .map((t) => {
      const first = log.turns.indexOf(t);
      const before = log.turns.slice(0, first).reduce((n, x) => n + x.calls.length, 0);
      return `<section class="api-turn"><h3>Prompt ${String(t.turn_index + 1).padStart(2, '0')} <span class="small">${t.calls.length} ${t.calls.length === 1 ? 'call' : 'calls'}</span></h3><p class="api-prompt">${esc(t.prompt)}</p>${t.calls.map((c, i) => apiCallHTML(c, before + i)).join('')}</section>`;
    })
    .join('');
  const setTo = log.temperature === undefined ? '' : `<div class="api-settings-line"><span class="chip"><b>Replay temperature</b>${esc(temperatureLabel(log.temperature))}</span><span class="chip"><b>Replay reasoning</b>${esc(reasoningLabel(log.reasoning_level))}</span><span class="chip"><b>Replay log probs</b>${log.logprobs ? 'On' : 'Off'}</span></div>`;
  return `<p class="modal-text">${calls} REST ${calls === 1 ? 'call' : 'calls'} to the provider for ${esc(modelLabel(log.model))}, in the order they were sent. The API key is never stored; it shows as a placeholder.</p>${setTo}${sections}`;
}

/** The API log popup. `title` says which replay it is. */
export const openApiLogModal = (log, title) =>
  showModal({
    title,
    bodyHTML: `<div class="api-log">${apiLogHTML(log)}</div>`,
    submitLabel: 'Close',
    cancelLabel: null,
    wide: true,
    className: 'api-log-modal',
  });

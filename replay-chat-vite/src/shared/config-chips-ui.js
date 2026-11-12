import { esc } from './html.js';
import { modelLabel } from './model-label.js';
import { reasoningLabel } from './reasoning.js';
import { temperatureLabel } from './temperature.js';

/**
 * A conversation's (or replay run's) settings as read-only chips: agent, model, reasoning level, temperature, KB summary tool.
 * `agentName` is the display name; `model` may be omitted (a replay has two).
 */
export const configChipsHTML = ({ agentName, model, reasoningLevel, temperature, kbSummaryTool, briefReplies }) =>
  `<div class="config-chips" aria-label="Settings (read-only)"><span class="chip"><b>Agent</b>${esc(agentName)}</span>${model ? `<span class="chip"><b>Model</b>${esc(modelLabel(model))}</span>` : ''}<span class="chip"><b>Reasoning</b>${esc(reasoningLabel(reasoningLevel))}</span><span class="chip"><b>Temperature</b>${esc(temperatureLabel(temperature))}</span><span class="chip"><b>KB summary tool</b>${kbSummaryTool ? 'On' : 'Off'}</span>${briefReplies === undefined ? '' : `<span class="chip"><b>Brief replies</b>${briefReplies ? 'On' : 'Off'}</span>`}</div>`;

/** The same settings as a bullet list ("Agent: General assistant"), for places that are short of width. */
export const configListHTML = ({ agentName, model, reasoningLevel, temperature, kbSummaryTool, briefReplies }) =>
  `<ul class="config-list" aria-label="Settings (read-only)">${[
    ['Agent', agentName],
    ['Model', model ? modelLabel(model) : ''],
    ['Reasoning', reasoningLabel(reasoningLevel)],
    ['Temperature', temperatureLabel(temperature)],
    ['KB summary tool', kbSummaryTool ? 'On' : 'Off'],
    ['Brief replies', briefReplies === undefined ? '' : briefReplies ? 'On' : 'Off'],
  ]
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `<li><b>${name}</b>${esc(value)}</li>`)
    .join('')}</ul>`;

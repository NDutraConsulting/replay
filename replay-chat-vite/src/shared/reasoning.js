/**
 * The reasoning levels a conversation or a replay can run with: OpenAI's `reasoning_effort` values, plus `default`
 * (the field is left out and the model's own default applies). Which values a model accepts differs by model; a model
 * that rejects one answers with an error that is shown as it is. Must match the backend's REASONING_LEVELS.
 */
export const REASONING_LEVELS = [
  { id: 'default', label: 'Default (model decides)' },
  { id: 'none', label: 'None' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
];

export const reasoningLabel = (id) => REASONING_LEVELS.find((l) => l.id === id)?.label ?? id;

export const reasoningOptionsHTML = (selected) =>
  REASONING_LEVELS.map((l) => `<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${l.label}</option>`).join('');

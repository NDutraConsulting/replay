/**
 * The APIs the Account page can fill in for you. Each has the base URL of its OpenAI-compatible Chat Completions endpoint
 * (the server adds /chat/completions). "Custom" has none: it is for an API on your own machine or network.
 *
 * Sources (checked November 2026): OpenAI api.openai.com/v1; Anthropic's OpenAI SDK compatibility layer
 * (api.anthropic.com/v1: a way to try Claude models, Chat Completions only, some OpenAI fields ignored); Gemini's OpenAI
 * compatibility (generativelanguage.googleapis.com/v1beta/openai); Fireworks AI (api.fireworks.ai/inference/v1);
 * Featherless AI (api.featherless.ai/v1).
 */
/** The OpenAI models offered as soon as OpenAI is added (the same list as the server's OPENAI_MODELS default). */
export const OPENAI_MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

export const API_PRESETS = [
  { id: 'openai', name: 'OpenAI', label: 'OpenAI', url: 'https://api.openai.com/v1', needsKey: true, note: 'OpenAI’s API. Use an OpenAI API key. Its models are filled in for you; add more later with Add models.', models: OPENAI_MODELS },
  {
    id: 'anthropic', name: 'Anthropic', label: 'Anthropic', url: 'https://api.anthropic.com/v1', needsKey: true,
    note: 'Anthropic’s OpenAI-compatible endpoint, meant for trying Claude models. It supports Chat Completions only and ignores some OpenAI fields. Use a Claude API key.',
  },
  {
    id: 'gemini', name: 'Google Gemini', label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true,
    note: 'Gemini’s OpenAI-compatible endpoint. Use a Gemini API key.',
  },
  {
    id: 'fireworks', name: 'Fireworks AI', label: 'Fireworks', url: 'https://api.fireworks.ai/inference/v1', needsKey: true,
    note: 'Fireworks AI’s OpenAI-compatible endpoint. Use a Fireworks API key.',
  },
  {
    id: 'featherless', name: 'Featherless AI', label: 'Featherless', url: 'https://api.featherless.ai/v1', needsKey: true,
    note: 'Featherless AI’s OpenAI-compatible endpoint. Use a Featherless API key.',
  },
  {
    id: 'custom', name: 'Custom (local API host)', label: '', url: '', needsKey: false, placeholder: 'http://localhost:11434/v1',
    note: 'For an API on your own machine or network, such as Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1) or vLLM (http://localhost:8000/v1). An address like that needs no key. The server reaches it, so “localhost” means the machine the server runs on.',
  },
]; // fmt: skip

export const presetById = (id) => API_PRESETS.find((p) => p.id === id) ?? null;

export const DEFAULT_PROVIDER_NOTE = 'Pick one to fill in its default URL, or choose Custom for an API on your own machine.';

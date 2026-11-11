/**
 * The temperature a conversation or a replay runs with: OpenAI's `temperature`, 0 to 2. 0 (the default here) is the least
 * random. A reasoning model takes it only when the reasoning level is None (the backend's OpenAI_API_Model_rules decide).
 */
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;
export const DEFAULT_TEMPERATURE = 0;

export const TEMPERATURE_HINT =
  '0 to 2. 0 is the least random. A reasoning model takes a temperature only when the reasoning level is None; otherwise it is not sent (the API log says so).';

/** How a temperature reads: 0, 0.7, 1.5 */
export const temperatureLabel = (t) => String(Number(t ?? DEFAULT_TEMPERATURE));

/** What the user typed as a number from 0 to 2, or null when it is not one (blank counts as not valid). */
export function parseTemperature(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_TEMPERATURE && n <= MAX_TEMPERATURE ? n : null;
}

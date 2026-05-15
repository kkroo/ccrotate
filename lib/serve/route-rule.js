// Maps incoming `model` field to one of "anthropic" or "openai" upstream,
// or null when we don't recognize the model. Caller surfaces 404 for null.
//
// Pure functions only — no I/O. Tested in route-rule.test.js.

export const ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
];

export const OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-5.5',
  'o1-preview',
  'text-embedding-3-small',
  'text-embedding-3-large',
];

const ANTHROPIC_PREFIXES = ['claude-'];
const OPENAI_PREFIXES = ['gpt-', 'o1-', 'text-embedding-', 'tts-', 'whisper-', 'davinci-', 'babbage-'];

export function pickUpstream(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  if (ANTHROPIC_PREFIXES.some(p => model.startsWith(p))) return 'anthropic';
  if (OPENAI_PREFIXES.some(p => model.startsWith(p))) return 'openai';
  return null;
}

export function listModels({ hasAnthropic, hasOpenai }) {
  const data = [];
  if (hasAnthropic) {
    for (const id of ANTHROPIC_MODELS) data.push({ id, object: 'model', owned_by: 'anthropic' });
  }
  if (hasOpenai) {
    for (const id of OPENAI_MODELS) data.push({ id, object: 'model', owned_by: 'openai' });
  }
  return { object: 'list', data };
}

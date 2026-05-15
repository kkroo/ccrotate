// Pure functions. OpenAI chat-completions <-> Anthropic messages.
// No I/O. Tested in translator.test.js via fixture corpus.

const DEFAULT_MAX_TOKENS = 4096;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function openaiToAnthropic(req) {
  // Reject material differences upfront.
  if (req.stream === true) {
    throw err('streaming_not_supported_v1',
              'streaming_not_supported_v1: stream:true is deferred to v2');
  }
  if (typeof req.n === 'number' && req.n > 1) {
    throw err('unsupported_parameter',
              `unsupported_parameter: n=${req.n} (Anthropic does not support n>1)`);
  }
  if (req.response_format && req.response_format.type === 'json_schema') {
    throw err('unsupported_parameter',
              'unsupported_parameter: response_format.type=json_schema not supported');
  }

  const out = { model: req.model, max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS };

  // Pull all system messages out into a single top-level `system` field.
  const sysParts = [];
  const restMsgs = [];
  for (const m of req.messages || []) {
    if (m.role === 'system') {
      sysParts.push(typeof m.content === 'string' ? m.content : '');
    } else {
      restMsgs.push(m);
    }
  }
  if (sysParts.length > 0) out.system = sysParts.join('\n');

  // For now (Task 3 — text-only), the user/assistant messages pass through.
  // Tool-call reshape lands in Task 5; multimodal in Task 6.
  out.messages = restMsgs.map(m => ({ role: m.role, content: m.content }));

  // Pass-through scalars.
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  // logprobs/seed/logit_bias intentionally dropped.

  return out;
}

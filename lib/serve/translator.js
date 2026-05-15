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

const STOP_REASON_MAP = {
  end_turn:      'stop',
  max_tokens:    'length',
  stop_sequence: 'stop',
  tool_use:      'tool_calls',
  refusal:       'content_filter',
};

export function anthropicToOpenai(res) {
  // Text content blocks are joined into one string. tool_use blocks land in Task 5.
  const textParts = [];
  for (const block of res.content || []) {
    if (block.type === 'text') textParts.push(block.text || '');
  }
  const content = textParts.length > 0 ? textParts.join('') : null;

  const finishReason = STOP_REASON_MAP[res.stop_reason] ?? 'stop';
  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;

  return {
    id: `chatcmpl-${res.id || 'unknown'}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

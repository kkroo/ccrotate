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

  // Reshape: OpenAI's `assistant.tool_calls` + following `tool` message →
  // Anthropic's content-block tool_use in assistant + tool_result in user.
  const outMsgs = [];
  for (const m of restMsgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls) {
        if (tc.type !== 'function') {
          throw err('unsupported_parameter',
                    `unsupported_parameter: tool_calls[].type=${tc.type} (only "function" supported)`);
        }
        let input;
        try { input = JSON.parse(tc.function.arguments || '{}'); }
        catch { throw err('invalid_request_error',
                          'invalid_request_error: tool_calls[].function.arguments must be valid JSON'); }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      outMsgs.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      outMsgs.push({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }
      ]});
    } else {
      outMsgs.push({ role: m.role, content: m.content });
    }
  }
  out.messages = outMsgs;

  // Tools (OpenAI's nested function shape → Anthropic's flatter input_schema)
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools.map(t => {
      if (t.type !== 'function' || !t.function) {
        throw err('unsupported_parameter',
                  'unsupported_parameter: tools[].type must be "function"');
      }
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      };
    });
  }

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
  const textParts = [];
  const toolCalls = [];
  for (const block of res.content || []) {
    if (block.type === 'text') textParts.push(block.text || '');
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const content = textParts.length > 0 ? textParts.join('') : (toolCalls.length > 0 ? '' : null);

  const message = { role: 'assistant', content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

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
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// Pure functions. OpenAI chat-completions <-> Anthropic messages.
// No I/O. Tested in translator.test.js via fixture corpus.

const DEFAULT_MAX_TOKENS = 4096;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function translateContent(content) {
  // Strings pass through.
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const u = part.image_url?.url || '';
      const dataMatch = u.match(/^data:([^;]+);base64,(.+)$/);
      if (dataMatch) {
        return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } };
      }
      return { type: 'image', source: { type: 'url', url: u } };
    }
    return part; // unknown block type — let upstream reject if material
  });
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
      outMsgs.push({ role: m.role, content: translateContent(m.content) });
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

function responsesContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (part.type === 'input_text' || part.type === 'output_text') {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'input_image') {
      const u = part.image_url || '';
      const dataMatch = u.match(/^data:([^;]+);base64,(.+)$/);
      if (dataMatch) {
        return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } };
      }
      return { type: 'image', source: { type: 'url', url: u } };
    }
    return part;
  });
}

function normalizeToolResultOutput(output) {
  if (typeof output === 'string') return output;
  return JSON.stringify(output ?? '');
}

export function responsesToAnthropic(req) {
  if (typeof req.n === 'number' && req.n > 1) {
    throw err('unsupported_parameter',
              `unsupported_parameter: n=${req.n} (Anthropic does not support n>1)`);
  }

  const out = {
    model: req.model,
    max_tokens: req.max_output_tokens ?? req.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    out.system = req.instructions;
  }

  const inputs = Array.isArray(req.input) ? req.input : [{ type: 'message', role: 'user', content: req.input ?? '' }];
  const messages = [];
  for (const item of inputs) {
    if (item?.type === 'message') {
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: responsesContentToAnthropic(item.content) });
    } else if (item?.type === 'function_call') {
      let input;
      try { input = JSON.parse(item.arguments || '{}'); }
      catch { input = {}; }
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: item.call_id || item.id, name: item.name, input }],
      });
    } else if (item?.type === 'function_call_output') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: normalizeToolResultOutput(item.output),
        }],
      });
    }
  }
  out.messages = messages;

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools
      .filter(t => t.type === 'function')
      .map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} },
      }));
  }

  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  return out;
}

export function anthropicToResponses(res) {
  const output = [];
  const textParts = [];
  let itemIndex = 0;

  for (const block of res.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text || '');
    } else if (block.type === 'tool_use') {
      output.push({
        id: `fc_${block.id || itemIndex}`,
        type: 'function_call',
        status: 'completed',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
      itemIndex += 1;
    }
  }

  if (textParts.length > 0) {
    output.unshift({
      id: `msg_${res.id || 'unknown'}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: textParts.join(''),
        annotations: [],
      }],
    });
  }

  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;

  return {
    id: `resp_${res.id || 'unknown'}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: res.model,
    output,
    output_text: textParts.join(''),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export function responsesSseBody(response) {
  const lines = [];
  const push = (type, data) => {
    lines.push(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  push('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  for (const [outputIndex, item] of response.output.entries()) {
    if (item.type === 'message') {
      push('response.output_item.added', {
        response_id: response.id,
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', content: [] },
      });
      for (const [contentIndex, part] of item.content.entries()) {
        push('response.content_part.added', {
          response_id: response.id,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: { ...part, text: '' },
        });
        if (part.type === 'output_text' && part.text) {
          push('response.output_text.delta', {
            response_id: response.id,
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
          });
          push('response.output_text.done', {
            response_id: response.id,
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            text: part.text,
          });
        }
        push('response.content_part.done', {
          response_id: response.id,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      }
    } else {
      push('response.output_item.added', {
        response_id: response.id,
        output_index: outputIndex,
        item,
      });
    }
    push('response.output_item.done', {
      response_id: response.id,
      output_index: outputIndex,
      item,
    });
  }
  push('response.completed', { response });
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

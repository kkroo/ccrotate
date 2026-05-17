import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import url from 'url';
import {
  openaiToAnthropic,
  anthropicToOpenai,
  responsesToAnthropic,
  anthropicToResponses,
  responsesSseBody,
} from './translator.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fix = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

describe('openaiToAnthropic (request) — text-only', () => {
  it('translates simple chat with system prompt', () => {
    const input = fix('openai-request-simple.json');
    const expected = fix('anthropic-request-simple.json');
    expect(openaiToAnthropic(input)).toEqual(expected);
  });

  it('defaults max_tokens to 4096 when caller omits it', () => {
    const input = { model: 'claude-haiku-4-5-20251001',
                    messages: [{role: 'user', content: 'hi'}] };
    const out = openaiToAnthropic(input);
    expect(out.max_tokens).toBe(4096);
  });

  it('concatenates multiple system messages into one top-level system string', () => {
    const input = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [
        {role: 'system', content: 'First.'},
        {role: 'system', content: 'Second.'},
        {role: 'user', content: 'hi'},
      ],
    };
    const out = openaiToAnthropic(input);
    expect(out.system).toBe('First.\nSecond.');
    expect(out.messages).toEqual([{role: 'user', content: 'hi'}]);
  });

  it('drops logprobs, seed, logit_bias silently', () => {
    const input = {
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      messages: [{role: 'user', content: 'hi'}],
      logprobs: true, seed: 42, logit_bias: {1: -100},
    };
    const out = openaiToAnthropic(input);
    expect(out.logprobs).toBeUndefined();
    expect(out.seed).toBeUndefined();
    expect(out.logit_bias).toBeUndefined();
  });

  it('throws on n>1', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'hi'}], n: 2,
    })).toThrow(/unsupported_parameter.*n/);
  });

  it('throws on response_format json_schema', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'hi'}],
      response_format: {type: 'json_schema', json_schema: {}},
    })).toThrow(/unsupported_parameter.*response_format/);
  });

  it('throws on stream:true (v1 deferral)', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'hi'}], stream: true,
    })).toThrow(/streaming_not_supported_v1/);
  });
});

describe('anthropicToOpenai (response) — text-only', () => {
  it('translates simple text response', () => {
    const input = fix('anthropic-response-simple.json');
    const expected = fix('openai-response-simple.json');
    const out = anthropicToOpenai(input);
    // `created` is a synthesized timestamp — assert it's present then strip
    expect(typeof out.created).toBe('number');
    delete out.created;
    expect(out).toEqual(expected);
  });

  it('maps stop_reason variants to finish_reason', () => {
    const base = {id: 'msg_x', type: 'message', role: 'assistant',
                  model: 'claude-haiku-4-5-20251001',
                  content: [{type: 'text', text: 'x'}],
                  usage: {input_tokens: 1, output_tokens: 1}};
    const map = {
      'end_turn':       'stop',
      'max_tokens':     'length',
      'stop_sequence':  'stop',
      'tool_use':       'tool_calls',
      'refusal':        'content_filter',
    };
    for (const [stopReason, finishReason] of Object.entries(map)) {
      const out = anthropicToOpenai({...base, stop_reason: stopReason});
      expect(out.choices[0].finish_reason).toBe(finishReason);
    }
  });

  it('joins multiple text content blocks into one content string', () => {
    const out = anthropicToOpenai({
      id: 'msg_x', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [
        {type: 'text', text: 'Hello '},
        {type: 'text', text: 'world.'},
      ],
      stop_reason: 'end_turn',
      usage: {input_tokens: 5, output_tokens: 3},
    });
    expect(out.choices[0].message.content).toBe('Hello world.');
  });

  it('total_tokens = prompt + completion', () => {
    const out = anthropicToOpenai({
      id: 'msg_x', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{type: 'text', text: 'x'}],
      stop_reason: 'end_turn',
      usage: {input_tokens: 100, output_tokens: 25},
    });
    expect(out.usage).toEqual({prompt_tokens: 100, completion_tokens: 25, total_tokens: 125});
  });
});

describe('translator — tool calls round-trip', () => {
  it('translates request with tool_calls and tool result', () => {
    const input = fix('openai-request-tools.json');
    const expected = fix('anthropic-request-tools.json');
    expect(openaiToAnthropic(input)).toEqual(expected);
  });

  it('translates response with text + tool_use blocks', () => {
    const input = fix('anthropic-response-tools.json');
    const expected = fix('openai-response-tools.json');
    const out = anthropicToOpenai(input);
    delete out.created;
    expect(out).toEqual(expected);
  });

  it('emits empty content "" (not null) when tool_use is the only block but no text', () => {
    // OpenAI clients vary — some require content to be a string. We use "" to be conservative.
    const out = anthropicToOpenai({
      id: 'msg_y', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{type: 'tool_use', id: 't1', name: 'f', input: {}}],
      stop_reason: 'tool_use',
      usage: {input_tokens: 1, output_tokens: 1},
    });
    expect(out.choices[0].message.content).toBe('');
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
  });
});

describe('translator — multimodal + edges', () => {
  it('translates user message with image_url (base64 data URI)', () => {
    const input = fix('openai-request-multimodal.json');
    const expected = fix('anthropic-request-multimodal.json');
    expect(openaiToAnthropic(input)).toEqual(expected);
  });

  it('translates http(s) image_url with type:"url"', () => {
    const input = {
      model: 'claude-haiku-4-5-20251001', max_tokens: 50,
      messages: [{role: 'user', content: [
        {type: 'text', text: 'q'},
        {type: 'image_url', image_url: {url: 'https://example.com/x.jpg'}},
      ]}],
    };
    const out = openaiToAnthropic(input);
    expect(out.messages[0].content[1]).toEqual({
      type: 'image', source: {type: 'url', url: 'https://example.com/x.jpg'},
    });
  });

  it('throws on tool_calls[].type other than function', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'assistant', content: null, tool_calls: [
        {id: 'x', type: 'custom', function: {name: 'f', arguments: '{}'}}
      ]}],
    })).toThrow(/unsupported_parameter.*tool_calls/);
  });

  it('throws on tools[].type other than function', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'q'}],
      tools: [{type: 'retrieval', function: {name: 'r', parameters: {}}}],
    })).toThrow(/unsupported_parameter.*tools/);
  });

  it('throws on invalid JSON in tool_calls[].function.arguments', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'assistant', content: null, tool_calls: [
        {id: 'x', type: 'function', function: {name: 'f', arguments: 'not-json'}}
      ]}],
    })).toThrow(/invalid_request_error/);
  });
});

describe('Responses API translation', () => {
  it('translates Codex-style responses input and tools to Anthropic messages', () => {
    const out = responsesToAnthropic({
      model: 'claude-haiku-4-5-20251001',
      instructions: 'Be brief.',
      max_output_tokens: 50,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'toolu_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' },
      ],
      tools: [{
        type: 'function',
        name: 'exec_command',
        description: 'run command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      }],
    });

    expect(out).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      system: 'Be brief.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: { cmd: 'pwd' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
      tools: [{
        name: 'exec_command',
        description: 'run command',
        input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      }],
    });
  });

  it('translates Anthropic text and tool_use blocks to Responses output items', () => {
    const out = anthropicToResponses({
      id: 'msg_1',
      model: 'claude-haiku-4-5-20251001',
      content: [
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: { cmd: 'pwd' } },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.output_text).toBe('done');
    expect(out.output[0].type).toBe('message');
    expect(out.output[1]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}',
    });
    expect(out.usage.total_tokens).toBe(7);
  });

  it('serializes Responses output as Codex-compatible SSE data events', () => {
    const body = responsesSseBody({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'claude-haiku-4-5-20251001',
      output: [{
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
      output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    expect(body).toContain('"type":"response.output_text.delta"');
    expect(body).toContain('"type":"response.completed"');
    expect(body).toContain('data: [DONE]');
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { openaiToAnthropic, anthropicToOpenai } from './translator.js';

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

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { openaiToAnthropic } from './translator.js';

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

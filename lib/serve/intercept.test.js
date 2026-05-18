import { describe, expect, it, vi } from 'vitest';
import {
  parseMarker,
  extractUserText,
  synthesizeMessagesResponse,
  synthesizeChatResponse,
  synthesizeResponsesResponse,
  synthesizeMessagesSse,
  tryIntercept,
} from './intercept.js';

describe('parseMarker', () => {
  it('extracts cmd from a bare marker', () => {
    expect(parseMarker('<!-- ccrotate-serve:cmd=when -->')).toEqual({ cmd: 'when', args: '' });
  });
  it('extracts cmd + args', () => {
    expect(parseMarker('<!-- ccrotate-serve:cmd=switch args=user@example.com -->'))
      .toEqual({ cmd: 'switch', args: 'user@example.com' });
  });
  it('is case-insensitive on the marker prefix', () => {
    expect(parseMarker('<!-- CCROTATE-SERVE:CMD=when -->')).toEqual({ cmd: 'when', args: '' });
  });
  it('returns null when no marker is present', () => {
    expect(parseMarker('hello world')).toBeNull();
    expect(parseMarker('')).toBeNull();
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker(undefined)).toBeNull();
  });
  it('ignores markers with bad cmd characters', () => {
    expect(parseMarker('<!-- ccrotate-serve:cmd=$$$ -->')).toBeNull();
  });
});

describe('extractUserText', () => {
  it('reads anthropic messages with string content', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    expect(extractUserText(body)).toBe('hi');
  });
  it('reads anthropic messages with array content (text blocks)', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
      ],
    };
    expect(extractUserText(body)).toBe('first\nsecond');
  });
  it('returns the LAST user message when assistant turns are interleaved', () => {
    const body = {
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'new' },
      ],
    };
    expect(extractUserText(body)).toBe('new');
  });
  it('reads openai responses body with string input', () => {
    expect(extractUserText({ input: 'hello' })).toBe('hello');
  });
  it('reads openai responses body with array input', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
      ],
    };
    expect(extractUserText(body)).toBe('q1');
  });
  it('returns empty string for empty bodies', () => {
    expect(extractUserText({})).toBe('');
    expect(extractUserText(null)).toBe('');
  });
});

describe('synthesizers', () => {
  it('synthesizeMessagesResponse has the Anthropic message shape', () => {
    const m = synthesizeMessagesResponse('hello');
    expect(m.type).toBe('message');
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(m.stop_reason).toBe('end_turn');
    expect(m.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
  it('synthesizeChatResponse has the OpenAI chat completion shape', () => {
    const c = synthesizeChatResponse('hi');
    expect(c.object).toBe('chat.completion');
    expect(c.choices[0].message.content).toBe('hi');
    expect(c.usage.total_tokens).toBe(0);
  });
  it('synthesizeResponsesResponse has the OpenAI responses shape', () => {
    const r = synthesizeResponsesResponse('payload');
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
    expect(r.output[0].content[0]).toEqual({ type: 'output_text', text: 'payload' });
  });
  it('synthesizeMessagesSse emits the canonical event sequence', () => {
    const sse = synthesizeMessagesSse('streamed');
    expect(sse).toContain('event: message_start');
    expect(sse).toContain('event: content_block_start');
    expect(sse).toContain('event: content_block_delta');
    expect(sse).toContain('"text_delta"');
    expect(sse).toContain('streamed');
    expect(sse).toContain('event: message_stop');
  });
});

describe('tryIntercept — dispatch', () => {
  function makeFakeCcrotate() {
    return {
      target: 'claude',
      setTarget: vi.fn(function (t) { this.target = t; }),
      getTargetName() { return this.target; },
      getCurrentAccount: vi.fn(() => ({ email: 'active@x' })),
      loadProfiles: vi.fn(() => ({ 'a@x': {}, 'b@x': {} })),
      loadTierCache: vi.fn(() => ({
        updatedAt: new Date().toISOString(),
        accounts: [
          { email: 'a@x', serviceTier: 'exhausted', rateLimits: { reset5h: Math.floor(Date.now() / 1000) + 3600 } },
          { email: 'b@x', serviceTier: 'available' },
        ],
      })),
      switch: vi.fn(async () => undefined),
      next: vi.fn(async () => ({ email: 'b@x' })),
    };
  }

  it('returns null when there is no marker', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: 'just a normal prompt' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
    });
    expect(r).toBeNull();
  });

  it('returns null when ccrotate is missing', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=when -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: null,
    });
    expect(r).toBeNull();
  });

  it('intercepts /v1/messages with cmd=when and returns a synthesized Anthropic response', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=when -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
    });
    expect(r.status).toBe(200);
    expect(r.headers['X-Ccrotate-Intercepted']).toBe('when');
    expect(r.headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(r.body);
    expect(parsed.type).toBe('message');
    expect(parsed.content[0].text).toContain('ccrotate pool');
  });

  it('intercepts /v1/messages stream=true with SSE body', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=help -->' }] },
      endpoint: 'messages',
      wantsStream: true,
      ccrotate: makeFakeCcrotate(),
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.body).toContain('event: message_start');
    expect(r.body).toContain('event: message_stop');
  });

  it('intercepts /v1/chat/completions and returns OpenAI shape', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=health -->' }] },
      endpoint: 'chat',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      serveStartedAt: Date.now() - 5000,
    });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.object).toBe('chat.completion');
    expect(parsed.choices[0].message.content).toContain('ccrotate-serve');
  });

  it('intercepts /v1/responses non-streaming', async () => {
    const r = await tryIntercept({
      body: { input: [{ role: 'user', content: [{ type: 'input_text', text: '<!-- ccrotate-serve:cmd=status -->' }] }] },
      endpoint: 'responses',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
    });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.object).toBe('response');
    expect(parsed.output[0].content[0].text).toContain('active@x');
  });

  it('switch returns a rendered confirmation', async () => {
    const fake = makeFakeCcrotate();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=switch args=u@x.com -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: fake,
    });
    expect(r.status).toBe(200);
    expect(fake.switch).toHaveBeenCalledWith('u@x.com');
    const parsed = JSON.parse(r.body);
    expect(parsed.content[0].text).toContain('switched');
  });

  it('switch rejects malformed email', async () => {
    const fake = makeFakeCcrotate();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=switch args=not-an-email -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: fake,
    });
    expect(r.status).toBe(200);
    expect(fake.switch).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).content[0].text).toContain('invalid email');
  });

  it('next calls ccrotate.next() and reports the new account', async () => {
    const fake = makeFakeCcrotate();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=next -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: fake,
    });
    expect(fake.next).toHaveBeenCalledWith({ wait: false });
    expect(JSON.parse(r.body).content[0].text).toContain('rotated');
  });

  it('snap returns informational text without touching ccrotate', async () => {
    const fake = makeFakeCcrotate();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=snap -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: fake,
    });
    expect(JSON.parse(r.body).content[0].text).toContain('must run locally');
  });

  it('unknown command surfaces the available list', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=banana -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
    });
    expect(JSON.parse(r.body).content[0].text).toContain('unknown command');
    expect(JSON.parse(r.body).content[0].text).toContain('when');
  });
});

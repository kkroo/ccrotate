import { describe, it, expect } from 'vitest';
import { pickUpstream, listModels, ANTHROPIC_MODELS, OPENAI_MODELS } from './route-rule.js';

describe('pickUpstream', () => {
  it('routes claude-* to anthropic', () => {
    expect(pickUpstream('claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(pickUpstream('claude-sonnet-4-6')).toBe('anthropic');
    expect(pickUpstream('claude-opus-4-7')).toBe('anthropic');
  });

  it('routes gpt-* and friends to openai', () => {
    for (const m of ['gpt-4o-mini', 'gpt-5.5', 'o1-preview', 'text-embedding-3-small',
                     'tts-1', 'whisper-1', 'davinci-002', 'babbage-002']) {
      expect(pickUpstream(m)).toBe('openai');
    }
  });

  it('returns null for unknown models (caller surfaces 404)', () => {
    expect(pickUpstream('palm-2')).toBeNull();
    expect(pickUpstream('')).toBeNull();
    expect(pickUpstream(undefined)).toBeNull();
  });
});

describe('listModels', () => {
  it('includes only configured backends', () => {
    const both = listModels({ hasAnthropic: true, hasOpenai: true });
    expect(both.object).toBe('list');
    expect(both.data.some(m => m.owned_by === 'anthropic')).toBe(true);
    expect(both.data.some(m => m.owned_by === 'openai')).toBe(true);

    const anthOnly = listModels({ hasAnthropic: true, hasOpenai: false });
    expect(anthOnly.data.every(m => m.owned_by === 'anthropic')).toBe(true);

    const oaiOnly = listModels({ hasAnthropic: false, hasOpenai: true });
    expect(oaiOnly.data.every(m => m.owned_by === 'openai')).toBe(true);
  });

  it('returns empty data when no backend is configured', () => {
    expect(listModels({ hasAnthropic: false, hasOpenai: false })).toEqual({ object: 'list', data: [] });
  });

  it('every advertised anthropic model routes to anthropic via pickUpstream', () => {
    for (const id of ANTHROPIC_MODELS) {
      expect(pickUpstream(id)).toBe('anthropic');
    }
  });

  it('every advertised openai model routes to openai via pickUpstream', () => {
    for (const id of OPENAI_MODELS) {
      expect(pickUpstream(id)).toBe('openai');
    }
  });
});

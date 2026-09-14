import { describe, expect, it } from 'vitest';
import { modelLabel } from './model-label';

describe('modelLabel', () => {
  it('strips only the vendor prefix and the release date', () => {
    expect(modelLabel('claude-sonnet-4-6-20260101')).toBe('sonnet-4-6');
    expect(modelLabel('claude-haiku-4-5')).toBe('haiku-4-5');
    expect(modelLabel('claude-opus-5[1m]')).toBe('opus-5[1m]');
  });

  it('shows an unrecognised id verbatim rather than guessing at it', () => {
    expect(modelLabel('gpt-4o')).toBe('gpt-4o');
    expect(modelLabel('deepseek-v3')).toBe('deepseek-v3');
    // 6 digits is not a release date — truncating here would invent a different model name.
    expect(modelLabel('some-model-202601')).toBe('some-model-202601');
    // Only a LEADING vendor prefix goes; `claude` inside an id is part of the name.
    expect(modelLabel('openai-codex/claude-proxy')).toBe('openai-codex/claude-proxy');
  });
});

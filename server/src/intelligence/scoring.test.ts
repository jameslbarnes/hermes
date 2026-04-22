import { describe, it, expect } from 'vitest';
import { shouldRoute, evaluateEntry } from './scoring.js';
import type { JournalEntry } from '../storage.js';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'test-id',
    pseudonym: 'Test User#abc123',
    client: 'desktop' as const,
    content: 'This is a test entry that is long enough to pass content-length checks for the routing pipeline.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('shouldRoute (hard rules)', () => {
  it('routes normal public entries', () => {
    expect(shouldRoute(makeEntry())).toBe(true);
  });

  it('does not route entries addressed to specific recipients', () => {
    expect(shouldRoute(makeEntry({ to: ['@alice'] }))).toBe(false);
  });

  it('does not route AI-only entries', () => {
    expect(shouldRoute(makeEntry({ aiOnly: true }))).toBe(false);
  });

  it('does not route entries shorter than MIN_CONTENT_LENGTH', () => {
    expect(shouldRoute(makeEntry({ content: 'too short' }))).toBe(false);
  });

  it('does not route private entries', () => {
    expect(shouldRoute(makeEntry({ visibility: 'private' }))).toBe(false);
  });

  it('does not route entries with humanVisible=false (legacy)', () => {
    expect(shouldRoute(makeEntry({ humanVisible: false } as any))).toBe(false);
  });
});

describe('evaluateEntry without Anthropic', () => {
  it('returns route=true for reflections without calling API', async () => {
    const entry = makeEntry({
      isReflection: true,
      content: 'A reflection'.padEnd(600, ' is long'),
    });
    const result = await evaluateEntry(entry, null, null);
    expect(result.route).toBe(true);
  });

  it('returns route=true for normal entries when no anthropic client', async () => {
    const result = await evaluateEntry(makeEntry(), null, null);
    expect(result.route).toBe(true);
  });

  it('returns route=false for entries failing hard rules', async () => {
    const result = await evaluateEntry(makeEntry({ aiOnly: true }), null, null);
    expect(result.route).toBe(false);
  });
});

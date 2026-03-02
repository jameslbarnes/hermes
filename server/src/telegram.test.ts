import { describe, it, expect } from 'vitest';
import { shouldPostToTelegram, formatEntryForTelegram } from './telegram.js';
import type { JournalEntry } from './storage.js';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'test-123',
    pseudonym: 'Quiet Feather#79c30b',
    client: 'code',
    content: 'Working on something interesting today.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('shouldPostToTelegram', () => {
  it('returns true for public entries', () => {
    expect(shouldPostToTelegram(makeEntry())).toBe(true);
  });

  it('returns true for ai-only entries', () => {
    expect(shouldPostToTelegram(makeEntry({ aiOnly: true }))).toBe(true);
  });

  it('returns true for legacy humanVisible: false entries', () => {
    expect(shouldPostToTelegram(makeEntry({ humanVisible: false }))).toBe(true);
  });

  it('returns false for addressed entries (to @handles)', () => {
    expect(shouldPostToTelegram(makeEntry({ to: ['@alice'] }))).toBe(false);
  });

  it('returns false for addressed entries (to emails)', () => {
    expect(shouldPostToTelegram(makeEntry({ to: ['alice@example.com'] }))).toBe(false);
  });

  it('returns false for entries with empty-but-truthy to array', () => {
    // Empty array means no addresses → public
    expect(shouldPostToTelegram(makeEntry({ to: [] }))).toBe(true);
  });

  it('returns false for explicitly private entries', () => {
    expect(shouldPostToTelegram(makeEntry({ visibility: 'private' }))).toBe(false);
  });
});

describe('formatEntryForTelegram', () => {
  const baseUrl = 'https://hermes.teleport.computer';

  it('formats public entry with pseudonym', () => {
    const entry = makeEntry();
    const result = formatEntryForTelegram(entry, baseUrl);
    expect(result).toContain('Quiet Feather\\#79c30b');
    expect(result).toContain('Working on something interesting today\\.');
    expect(result).toContain('Permalink');
    expect(result).toContain('entry\\-test\\-123');
  });

  it('formats public entry with handle', () => {
    const entry = makeEntry({ handle: 'james' });
    const result = formatEntryForTelegram(entry, baseUrl);
    expect(result).toContain('@james');
  });

  it('formats ai-only entry as stub with topic hints', () => {
    const entry = makeEntry({
      aiOnly: true,
      topicHints: ['auth', 'TEE'],
    });
    const result = formatEntryForTelegram(entry, baseUrl);
    expect(result).toContain('posted about: auth, TEE');
    // Should NOT contain the full content
    expect(result).not.toContain('Working on something interesting');
  });

  it('formats ai-only entry as stub without topic hints', () => {
    const entry = makeEntry({ aiOnly: true });
    const result = formatEntryForTelegram(entry, baseUrl);
    expect(result).toContain('posted about: various topics');
  });

  it('formats legacy humanVisible: false as stub', () => {
    const entry = makeEntry({ humanVisible: false, topicHints: ['testing'] });
    const result = formatEntryForTelegram(entry, baseUrl);
    expect(result).toContain('posted about: testing');
  });

  it('escapes MarkdownV2 special characters', () => {
    const entry = makeEntry({ content: 'Hello _world_ *bold* [link](url) ~strike~' });
    const result = formatEntryForTelegram(entry, baseUrl);
    // All special chars should be escaped
    expect(result).toContain('\\_world\\_');
    expect(result).toContain('\\*bold\\*');
    expect(result).toContain('\\[link\\]');
    expect(result).toContain('\\~strike\\~');
  });

  it('truncates long content', () => {
    const longContent = 'x'.repeat(4000);
    const entry = makeEntry({ content: longContent });
    const result = formatEntryForTelegram(entry, baseUrl);
    expect(result).toContain('Read full entry');
    // The escaped content + overhead should be under Telegram's limit
    expect(result.length).toBeLessThan(5000);
  });
});

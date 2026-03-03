import { describe, it, expect } from 'vitest';
import { shouldPostToTelegram, formatEntryForTelegram, formatCuratedPost, trackPostedEntry } from './telegram/filter.js';
import { MessageBuffer } from './telegram/buffer.js';
import { RateLimiter } from './telegram/rate-limiter.js';
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

// ─── Filter tests (unchanged behavior) ──────────────────────

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

// ─── Curated post tests ─────────────────────────────────────

describe('formatCuratedPost', () => {
  const baseUrl = 'https://hermes.teleport.computer';

  it('formats hook with author and permalink', () => {
    const entry = makeEntry({ handle: 'alice' });
    const result = formatCuratedPost(entry, 'Third person this week to find chunk size > model choice.', baseUrl);
    expect(result).toContain('Third person this week');
    expect(result).toContain('alice');
    expect(result).toContain('Read full entry');
    expect(result).toContain('entry\\-test\\-123');
  });

  it('escapes special characters in hook', () => {
    const entry = makeEntry({ handle: 'bob' });
    const result = formatCuratedPost(entry, '@dave found the _opposite_ — wild.', baseUrl);
    expect(result).toContain('@dave');
    expect(result).toContain('\\_opposite\\_');
  });

  it('uses pseudonym when no handle', () => {
    const entry = makeEntry();
    const result = formatCuratedPost(entry, 'A sharp observation.', baseUrl);
    expect(result).toContain('Quiet Feather');
  });
});

describe('trackPostedEntry', () => {
  it('stores author and hook', () => {
    const entry = makeEntry({ handle: 'alice' });
    const result = trackPostedEntry([], entry, 'Great hook here');
    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('@alice');
    expect(result[0].hook).toBe('Great hook here');
  });

  it('uses pseudonym when no handle', () => {
    const entry = makeEntry();
    const result = trackPostedEntry([], entry);
    expect(result[0].author).toBe('Quiet Feather#79c30b');
    expect(result[0].hook).toBeUndefined();
  });

  it('maintains sliding window of 10', () => {
    let posted: any[] = [];
    for (let i = 0; i < 15; i++) {
      posted = trackPostedEntry(posted, makeEntry({ id: `entry-${i}`, handle: 'a' }));
    }
    expect(posted).toHaveLength(10);
    expect(posted[0].entryId).toBe('entry-5');
    expect(posted[9].entryId).toBe('entry-14');
  });
});

// ─── Buffer tests ───────────────────────────────────────────

describe('MessageBuffer', () => {
  it('stores and retrieves messages', () => {
    const buf = new MessageBuffer(5);
    buf.push({ senderName: 'Alice', text: 'Hello', timestamp: 1000, messageId: 1 });
    buf.push({ senderName: 'Bob', text: 'World', timestamp: 2000, messageId: 2 });
    expect(buf.size).toBe(2);
    expect(buf.recent(10)).toHaveLength(2);
    expect(buf.recent(1)).toHaveLength(1);
    expect(buf.recent(1)[0].senderName).toBe('Bob');
  });

  it('drops oldest messages when at capacity', () => {
    const buf = new MessageBuffer(3);
    buf.push({ senderName: 'A', text: '1', timestamp: 1000, messageId: 1 });
    buf.push({ senderName: 'B', text: '2', timestamp: 2000, messageId: 2 });
    buf.push({ senderName: 'C', text: '3', timestamp: 3000, messageId: 3 });
    buf.push({ senderName: 'D', text: '4', timestamp: 4000, messageId: 4 });
    expect(buf.size).toBe(3);
    expect(buf.recent(10)[0].senderName).toBe('B');
    expect(buf.recent(10)[2].senderName).toBe('D');
  });

  it('tracks messages since last check', () => {
    const buf = new MessageBuffer();
    buf.push({ senderName: 'A', text: '1', timestamp: 1000, messageId: 1 });
    buf.push({ senderName: 'B', text: '2', timestamp: 2000, messageId: 2 });
    expect(buf.messagesSinceCheck).toBe(2);
    buf.resetCheckCounter();
    expect(buf.messagesSinceCheck).toBe(0);
    buf.push({ senderName: 'C', text: '3', timestamp: 3000, messageId: 3 });
    expect(buf.messagesSinceCheck).toBe(1);
  });

  it('formats messages for context', () => {
    const buf = new MessageBuffer();
    buf.push({ senderName: 'Alice', text: 'Hello there', timestamp: new Date('2026-01-01T12:30:00Z').getTime(), messageId: 1 });
    buf.push({ senderName: 'Bob', text: 'Hi Alice', timestamp: new Date('2026-01-01T12:31:00Z').getTime(), messageId: 2 });
    const formatted = buf.formatForContext(10);
    expect(formatted).toContain('[12:30] Alice: Hello there');
    expect(formatted).toContain('[12:31] Bob: Hi Alice');
  });

  it('returns placeholder for empty buffer', () => {
    const buf = new MessageBuffer();
    expect(buf.formatForContext(10)).toBe('(no recent messages)');
  });

  it('clears all messages', () => {
    const buf = new MessageBuffer();
    buf.push({ senderName: 'A', text: '1', timestamp: 1000, messageId: 1 });
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.messagesSinceCheck).toBe(0);
  });

  it('returns latest message', () => {
    const buf = new MessageBuffer();
    expect(buf.latest()).toBeNull();
    buf.push({ senderName: 'A', text: 'first', timestamp: 1000, messageId: 1 });
    buf.push({ senderName: 'B', text: 'second', timestamp: 2000, messageId: 2 });
    expect(buf.latest()?.text).toBe('second');
  });
});

// ─── ConversationHeat tests ─────────────────────────────────

describe('MessageBuffer.measureHeat', () => {
  it('returns cold for empty buffer', () => {
    const buf = new MessageBuffer();
    const heat = buf.measureHeat(10 * 60 * 1000);
    expect(heat.isHot).toBe(false);
    expect(heat.recentCount).toBe(0);
  });

  it('returns cold for few messages from few senders', () => {
    const buf = new MessageBuffer();
    const now = Date.now();
    // Only 2 people, 3 messages — not hot
    buf.push({ senderName: 'Alice', text: 'hello there friend', timestamp: now - 5000, messageId: 1 });
    buf.push({ senderName: 'Bob', text: 'hey how are you doing today', timestamp: now - 4000, messageId: 2 });
    buf.push({ senderName: 'Alice', text: 'doing great thanks for asking', timestamp: now - 3000, messageId: 3 });
    const heat = buf.measureHeat(10 * 60 * 1000, now);
    expect(heat.isHot).toBe(false);
    expect(heat.uniqueSenders).toBe(2);
  });

  it('returns hot for active multi-person conversation', () => {
    const buf = new MessageBuffer();
    const now = Date.now();
    const substantive = 'This is a substantive message about an interesting topic that has real content in it.';
    // 3+ people, 8+ messages, long enough text
    for (let i = 0; i < 10; i++) {
      const sender = ['Alice', 'Bob', 'Carol', 'Dave'][i % 4];
      buf.push({ senderName: sender, text: substantive, timestamp: now - (10 - i) * 1000, messageId: i + 1 });
    }
    const heat = buf.measureHeat(10 * 60 * 1000, now);
    expect(heat.isHot).toBe(true);
    expect(heat.uniqueSenders).toBe(4);
    expect(heat.recentCount).toBe(10);
  });

  it('excludes messages outside the time window', () => {
    const buf = new MessageBuffer();
    const now = Date.now();
    const substantive = 'This is a substantive message about an interesting topic that has real content in it.';
    // All messages are 20 minutes old — outside 10-min window
    for (let i = 0; i < 10; i++) {
      const sender = ['Alice', 'Bob', 'Carol', 'Dave'][i % 4];
      buf.push({ senderName: sender, text: substantive, timestamp: now - 20 * 60 * 1000, messageId: i + 1 });
    }
    const heat = buf.measureHeat(10 * 60 * 1000, now);
    expect(heat.isHot).toBe(false);
    expect(heat.recentCount).toBe(0);
  });

  it('returns cold for many short messages (not substantive)', () => {
    const buf = new MessageBuffer();
    const now = Date.now();
    // 10 messages, 4 senders, but very short text
    for (let i = 0; i < 10; i++) {
      const sender = ['Alice', 'Bob', 'Carol', 'Dave'][i % 4];
      buf.push({ senderName: sender, text: 'lol', timestamp: now - (10 - i) * 1000, messageId: i + 1 });
    }
    const heat = buf.measureHeat(10 * 60 * 1000, now);
    expect(heat.isHot).toBe(false);
    expect(heat.avgLength).toBe(3);
  });
});

// ─── RateLimiter tests ──────────────────────────────────────

describe('RateLimiter', () => {
  it('allows first post', () => {
    const rl = new RateLimiter({ maxPerHour: 6, maxPerDay: 30, cooldownMs: 300_000 });
    expect(rl.canPost()).toBe(true);
  });

  it('enforces cooldown between posts', () => {
    const rl = new RateLimiter({ maxPerHour: 6, maxPerDay: 30, cooldownMs: 300_000 });
    const now = Date.now();
    rl.record(now);
    // Too soon
    expect(rl.canPost(now + 60_000)).toBe(false);
    // After cooldown
    expect(rl.canPost(now + 300_001)).toBe(true);
  });

  it('enforces hourly limit', () => {
    const rl = new RateLimiter({ maxPerHour: 3, maxPerDay: 30, cooldownMs: 1000 });
    const now = Date.now();
    rl.record(now);
    rl.record(now + 2000);
    rl.record(now + 4000);
    // 3 posts in the hour, should be blocked even after cooldown
    expect(rl.canPost(now + 6000)).toBe(false);
    // After an hour, should be allowed
    expect(rl.canPost(now + 3600_001)).toBe(true);
  });

  it('enforces daily limit', () => {
    const rl = new RateLimiter({ maxPerHour: 100, maxPerDay: 3, cooldownMs: 1000 });
    const now = Date.now();
    rl.record(now);
    rl.record(now + 2000);
    rl.record(now + 4000);
    expect(rl.canPost(now + 6000)).toBe(false);
  });

  it('counts last hour and last day', () => {
    const rl = new RateLimiter({ maxPerHour: 6, maxPerDay: 30, cooldownMs: 1000 });
    const now = Date.now();
    rl.record(now - 30 * 60 * 1000); // 30 min ago
    rl.record(now - 2 * 60 * 60 * 1000); // 2 hours ago
    expect(rl.countLastHour(now)).toBe(1);
    expect(rl.countLastDay(now)).toBe(2);
  });

  it('prunes old timestamps', () => {
    const rl = new RateLimiter({ maxPerHour: 6, maxPerDay: 30, cooldownMs: 1000 });
    const now = Date.now();
    rl.record(now - 25 * 60 * 60 * 1000); // 25 hours ago
    expect(rl.countLastDay(now)).toBe(0);
  });
});

// ─── Channel rate limit tests ───────────────────────────────

describe('isChannelRateLimited', () => {
  // Import inline to avoid circular dep issues in test
  it('allows posts under the limit', async () => {
    const { isChannelRateLimited } = await import('./telegram/filter.js');
    const timestamps = [Date.now() - 30 * 60 * 1000]; // 1 post 30 min ago
    expect(isChannelRateLimited(timestamps)).toBe(false);
  });

  it('blocks posts at the limit', async () => {
    const { isChannelRateLimited } = await import('./telegram/filter.js');
    const now = Date.now();
    // 10 posts in the last hour = at limit
    const timestamps = Array.from({ length: 10 }, (_, i) => now - i * 5 * 60 * 1000);
    expect(isChannelRateLimited(timestamps, now)).toBe(true);
  });

  it('allows posts when old timestamps expire', async () => {
    const { isChannelRateLimited } = await import('./telegram/filter.js');
    const now = Date.now();
    // 10 posts, but all > 1 hour ago
    const timestamps = Array.from({ length: 10 }, (_, i) => now - 2 * 60 * 60 * 1000 - i * 1000);
    expect(isChannelRateLimited(timestamps, now)).toBe(false);
  });
});

// ─── State persistence tests ────────────────────────────────

describe('State persistence', () => {
  it('loadState returns empty state when no file exists', async () => {
    const { loadState } = await import('./telegram/state.js');
    // In test env, /data/ doesn't exist, so loadState should return defaults
    const state = loadState();
    expect(state.surfacedEntryIds).toEqual([]);
    expect(state.recentlyPosted).toEqual([]);
    expect(state.lastWritebackTime).toBe(0);
  });
});

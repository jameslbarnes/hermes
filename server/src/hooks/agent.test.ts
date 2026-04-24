import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../storage.js';
import { getMatrixRoutingTargets, getPublishedEntryFromEvent, hasLinkedPlatformAccount } from './agent.js';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'entry-1',
    pseudonym: 'Test User#abc123',
    client: 'desktop' as const,
    content: 'This is a public notebook entry that is long enough to be eligible for Matrix posting.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('getMatrixRoutingTargets', () => {
  it('posts normal public entries to feed', () => {
    expect(getMatrixRoutingTargets(makeEntry())).toEqual({
      postToFeed: true,
      channelDests: [],
    });
  });

  it('posts channel-addressed entries to channel rooms only', () => {
    expect(getMatrixRoutingTargets(makeEntry({
      to: ['#books', '#feed'],
      visibility: 'private',
    }))).toEqual({
      postToFeed: false,
      channelDests: ['books', 'feed'],
    });
  });

  it('does not post direct messages to feed', () => {
    expect(getMatrixRoutingTargets(makeEntry({
      to: ['@alice'],
      visibility: 'private',
    }))).toEqual({
      postToFeed: false,
      channelDests: [],
    });
  });

  it('does not post ai-only entries', () => {
    expect(getMatrixRoutingTargets(makeEntry({
      aiOnly: true,
      humanVisible: false,
    } as Partial<JournalEntry>))).toEqual({
      postToFeed: false,
      channelDests: [],
    });
  });
});

describe('getPublishedEntryFromEvent', () => {
  it('uses the stored entry when available', () => {
    const entry = makeEntry({ id: 'stored-entry' });
    expect(getPublishedEntryFromEvent(entry, {})).toBe(entry);
  });

  it('falls back to the event snapshot when storage misses', () => {
    const snapshot = makeEntry({ id: 'snapshot-entry', handle: 'james' });
    expect(getPublishedEntryFromEvent(null, { entry: snapshot })).toEqual(snapshot);
  });

  it('returns null when neither storage nor the event has a usable entry', () => {
    expect(getPublishedEntryFromEvent(null, {})).toBeNull();
    expect(getPublishedEntryFromEvent(null, { entry: { id: 'bad' } })).toBeNull();
  });
});

describe('hasLinkedPlatformAccount', () => {
  it('returns true for linked matrix accounts', () => {
    expect(hasLinkedPlatformAccount({
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true },
      ],
    }, 'matrix')).toBe(true);
  });

  it('returns false when no linked matrix account exists', () => {
    expect(hasLinkedPlatformAccount({
      linkedAccounts: [
        { platform: 'telegram', platformUserId: '1234', linkedAt: Date.now(), verified: true },
      ],
    }, 'matrix')).toBe(false);
  });

  it('returns false for explicitly unverified links', () => {
    expect(hasLinkedPlatformAccount({
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: false },
      ],
    }, 'matrix')).toBe(false);
  });
});

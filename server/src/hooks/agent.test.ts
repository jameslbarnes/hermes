import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, type JournalEntry } from '../storage.js';
import { MatrixPlatform, ROUTER_SPARK_EVENT } from '../platform/matrix.js';
import { getMatrixRoutingTargets, getPublishedEntryFromEvent, getUnexpectedSparkHandles, hasLinkedPlatformAccount, triggerManualSpark } from './agent.js';

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

describe('getUnexpectedSparkHandles', () => {
  it('allows only the two spark participants in generated spark text', () => {
    expect(
      getUnexpectedSparkHandles(
        'Hey @socrates1024 and @ggg, this is for you.',
        'socrates1024',
        'ggg',
      ),
    ).toEqual([]);
  });

  it('flags third-party handles so the room pair cannot diverge from the message', () => {
    expect(
      getUnexpectedSparkHandles(
        'Hey @socrates1024 and @sxysun, @ggg has relevant work here.',
        'socrates1024',
        'sxysun',
      ),
    ).toEqual(['ggg']);
  });
});

describe('triggerManualSpark', () => {
  it('does not reuse a stored spark room whose Matrix state belongs to another pair', async () => {
    const storage = new MemoryStorage();
    await storage.createUser({
      handle: 'socrates1024',
      secretKeyHash: 'hash-s',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@socrates1024:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    await storage.createUser({
      handle: 'ggg',
      secretKeyHash: 'hash-g',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@ggg:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    await storage.setSparkPairRoom('socrates1024', 'ggg', '!sxysun-room:mtrx.example.test');

    const platform = new MatrixPlatform({
      serverUrl: 'https://mtrx.example.test',
      serverName: 'mtrx.example.test',
      botSecretKey: 'test-secret',
      botHandle: 'router',
      resolveLinkedPlatformId: async (_platform, handle) => `@${handle}:matrix.org`,
    });

    const createRoom = vi.fn().mockResolvedValue({ room_id: '!correct-room:mtrx.example.test' });
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$state' });

    (platform as any).client = {
      createRoom,
      sendMessage,
      sendStateEvent,
      getRoom: vi.fn((roomId: string) => roomId === '!sxysun-room:mtrx.example.test'
        ? {
          currentState: {
            getStateEvents: (eventType: string) => eventType === ROUTER_SPARK_EVENT
              ? { getContent: () => ({ source_handle: 'sxysun', target_handle: 'socrates1024' }) }
              : null,
          },
        }
        : null),
    };

    await triggerManualSpark(
      'socrates1024',
      'ggg',
      'Manual test for the correct pair.',
      [platform],
      storage,
      'Hey @socrates1024 and @ggg, compare notes here.',
    );

    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      name: '@socrates1024 ↔ @ggg',
    }));
    await expect(storage.getSparkPairRoom('socrates1024', 'ggg')).resolves.toBe('!correct-room:mtrx.example.test');
  });
});

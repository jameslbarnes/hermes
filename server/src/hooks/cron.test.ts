import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntry, Storage, User } from '../storage.js';
import type { Platform } from '../platform/types.js';

const { messagesCreate } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function MockAnthropic() {
    return {
    messages: {
      create: messagesCreate,
    },
    };
  }),
}));

import { registerPlatform } from '../platform/registry.js';
import { generateDailyDigest, GLOBAL_DIGEST_MODEL, PERSONALIZED_DIGEST_MODEL, sendPersonalizedDigests } from './cron.js';

function yesterdayAtNoon(): number {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 12).getTime();
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    handle: 'alice',
    secretKeyHash: 'hash',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'entry-1',
    pseudonym: 'Test User#abc123',
    client: 'desktop',
    content: 'A public notebook entry about Matrix digest delivery.',
    timestamp: yesterdayAtNoon(),
    ...overrides,
  };
}

function makeStorage(overrides: Partial<Storage> & Record<string, any> = {}): Storage {
  return {
    getAllUsers: vi.fn(async () => []),
    getUser: vi.fn(async () => null),
    getEntriesSince: vi.fn(async () => []),
    getEntriesByHandle: vi.fn(async () => []),
    getEntriesAddressedTo: vi.fn(async () => []),
    ...overrides,
  } as unknown as Storage;
}

function registerMatrixPlatform() {
  const sendMessage = vi.fn(async () => '$msg');
  const sendDM = vi.fn(async () => '$dm');
  const ensureChannelRoom = vi.fn(async () => '!digest:matrix.test');
  const platform: Platform = {
    name: 'matrix',
    maxMessageLength: 65536,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendMessage,
    sendDM,
    createRoom: vi.fn(async () => ({ id: '!room:test', type: 'group' as const, platform: 'matrix' })),
    inviteToRoom: vi.fn(async () => {}),
    removeFromRoom: vi.fn(async () => {}),
    setRoomTopic: vi.fn(async () => {}),
    setUserRole: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    resolveHermesHandle: vi.fn(async () => null),
    resolvePlatformId: vi.fn(async handle => `@${handle}:matrix.test`),
    formatContent: text => text,
    ensureChannelRoom,
  } as Platform & { ensureChannelRoom: typeof ensureChannelRoom };

  registerPlatform(platform);
  return { platform, sendDM, sendMessage, ensureChannelRoom };
}

describe('generateDailyDigest', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Global digest body.' }],
    });
  });

  it('posts a global Opus-authored digest to the Matrix #digest room', async () => {
    const { sendMessage, ensureChannelRoom } = registerMatrixPlatform();
    const addDailySummary = vi.fn(async summary => ({ id: `daily-${summary.date}`, ...summary }));
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => [
        makeEntry({
          id: 'public-feed',
          handle: 'alice',
          content: 'Alice wrote about Matrix routing and digest delivery.',
          topicHints: ['matrix', 'digest'],
        }),
        makeEntry({
          id: 'public-channel',
          handle: 'bob',
          content: 'Bob posted a channel update about notebook synthesis.',
          to: ['#books'],
        }),
      ]),
      addDailySummary,
    });

    await expect(generateDailyDigest(storage)).resolves.toMatchObject({
      posted: true,
      entryCount: 2,
      includedEntryCount: 2,
      roomId: '!digest:matrix.test',
    });

    expect(ensureChannelRoom).toHaveBeenCalledWith('digest', 'Daily Digest', 'Daily summary of notebook activity');
    expect(sendMessage).toHaveBeenCalledWith('!digest:matrix.test', expect.stringContaining('Global digest body.'));
    expect(sendMessage).toHaveBeenCalledWith('!digest:matrix.test', expect.stringContaining('# Daily Digest'));
    expect(addDailySummary).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Global digest body.',
      entryCount: 2,
      pseudonyms: ['@alice', '@bob'],
    }));
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: GLOBAL_DIGEST_MODEL,
      messages: [expect.objectContaining({
        content: expect.stringContaining('Alice wrote about Matrix routing'),
      })],
    }));
  });

  it('excludes private addressed and AI-only entries from the global prompt', async () => {
    registerMatrixPlatform();
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'public', handle: 'alice', content: 'Public feed entry.' }),
        makeEntry({ id: 'private-handle', handle: 'alice', content: 'Private handle entry should not leak.', to: ['@bob'] }),
        makeEntry({ id: 'private-email', handle: 'alice', content: 'Private email entry should not leak.', to: ['person@example.com'] }),
        makeEntry({ id: 'ai-only', handle: 'alice', content: 'AI only entry should not leak.', aiOnly: true }),
      ]),
    });

    await generateDailyDigest(storage);

    const prompt = messagesCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Public feed entry.');
    expect(prompt).not.toContain('Private handle entry should not leak.');
    expect(prompt).not.toContain('Private email entry should not leak.');
    expect(prompt).not.toContain('AI only entry should not leak.');
  });
});

describe('sendPersonalizedDigests', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Personalized digest body.' }],
    });
  });

  it('sends to verified linked Matrix users even when they did not post yesterday', async () => {
    const { sendDM } = registerMatrixPlatform();
    const alice = makeUser({
      handle: 'alice',
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.test', linkedAt: Date.now(), verified: true },
      ],
    });

    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [alice]),
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'entry-carol', handle: 'carol', content: 'Carol shipped a new channel workflow.' }),
      ]),
      getEntriesByHandle: vi.fn(async () => [
        makeEntry({ id: 'entry-alice-old', handle: 'alice', timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, content: 'Alice has been thinking about Matrix notifications.' }),
      ]),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sendDM).toHaveBeenCalledWith('@alice:matrix.test', expect.stringContaining('Personalized digest body.'));
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: PERSONALIZED_DIGEST_MODEL,
      messages: [expect.objectContaining({
        content: expect.stringContaining("Recipient's recent notebook corpus"),
      })],
    }));
  });

  it('does not require a profile object when the recipient has Matrix linked', async () => {
    const { sendDM } = registerMatrixPlatform();
    const alice = makeUser({
      handle: 'alice',
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.test', linkedAt: Date.now(), verified: true },
      ],
    });

    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [alice]),
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'entry-bob', handle: 'bob', content: 'Bob wrote about shared notebook digests.' }),
      ]),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sendDM).toHaveBeenCalledTimes(1);
  });

  it('skips users without a verified linked Matrix account', async () => {
    const { sendDM } = registerMatrixPlatform();
    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [
        makeUser({ handle: 'alice' }),
      ]),
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'entry-bob', handle: 'bob' }),
      ]),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(sendDM).not.toHaveBeenCalled();
  });
});

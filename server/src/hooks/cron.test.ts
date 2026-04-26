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
import { sendPersonalizedDigests } from './cron.js';

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

function makeStorage(overrides: Partial<Storage> = {}): Storage {
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
  const sendDM = vi.fn(async () => '$dm');
  const platform: Platform = {
    name: 'matrix',
    maxMessageLength: 65536,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => '$msg'),
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
  };

  registerPlatform(platform);
  return { platform, sendDM };
}

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

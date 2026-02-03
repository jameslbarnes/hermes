import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from './storage.js';
import { hashSecretKey } from './identity.js';
import {
  parseDestination,
  parseDestinations,
  resolveDestinations,
  isInternalUrl,
  getDefaultVisibility,
  canViewEntry,
} from './delivery.js';

describe('Delivery module', () => {
  describe('parseDestination', () => {
    it('should parse @handle destinations', () => {
      const dest = parseDestination('@alice');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('alice');
    });

    it('should parse @handle with uppercase', () => {
      const dest = parseDestination('@Alice');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('alice');
    });

    it('should parse email destinations', () => {
      const dest = parseDestination('bob@example.com');
      expect(dest.type).toBe('email');
      expect((dest as any).email).toBe('bob@example.com');
    });

    it('should parse webhook URL destinations', () => {
      const dest = parseDestination('https://webhook.example.com/hook');
      expect(dest.type).toBe('webhook');
      expect((dest as any).url).toBe('https://webhook.example.com/hook');
    });

    it('should parse http webhook URLs', () => {
      const dest = parseDestination('http://localhost:3000/hook');
      expect(dest.type).toBe('webhook');
      expect((dest as any).url).toBe('http://localhost:3000/hook');
    });

    it('should treat bare handles as handles', () => {
      const dest = parseDestination('charlie');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('charlie');
    });

    it('should trim whitespace', () => {
      const dest = parseDestination('  @alice  ');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('alice');
    });
  });

  describe('parseDestinations', () => {
    it('should parse multiple destinations', () => {
      const dests = parseDestinations([
        '@alice',
        'bob@example.com',
        'https://webhook.example.com/hook',
      ]);

      expect(dests).toHaveLength(3);
      expect(dests[0].type).toBe('handle');
      expect(dests[1].type).toBe('email');
      expect(dests[2].type).toBe('webhook');
    });
  });

  describe('resolveDestinations', () => {
    let storage: MemoryStorage;

    beforeEach(async () => {
      storage = new MemoryStorage();
      // Create test users
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-secret-key-1234567890'),
        email: 'alice@example.com',
      });
      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-secret-key-1234567890'),
        email: 'bob@example.com',
      });
    });

    it('should resolve @handle to user', async () => {
      const dests = await resolveDestinations(['@alice'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('handle');
      expect((dests[0] as any).user).toBeDefined();
      expect((dests[0] as any).user.handle).toBe('alice');
    });

    it('should resolve email to user when email matches', async () => {
      const dests = await resolveDestinations(['alice@example.com'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('email');
      expect((dests[0] as any).user).toBeDefined();
      expect((dests[0] as any).user.handle).toBe('alice');
    });

    it('should not attach user to unknown handle', async () => {
      const dests = await resolveDestinations(['@unknown'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('handle');
      expect((dests[0] as any).user).toBeUndefined();
    });

    it('should not attach user to unknown email', async () => {
      const dests = await resolveDestinations(['unknown@example.com'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('email');
      expect((dests[0] as any).user).toBeUndefined();
    });

    it('should pass through webhook URLs unchanged', async () => {
      const dests = await resolveDestinations(['https://webhook.example.com/hook'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('webhook');
      expect((dests[0] as any).url).toBe('https://webhook.example.com/hook');
    });
  });

  describe('isInternalUrl', () => {
    it('should block localhost', () => {
      expect(isInternalUrl('http://localhost:3000/hook')).toBe(true);
      expect(isInternalUrl('https://localhost/hook')).toBe(true);
    });

    it('should block 127.0.0.1', () => {
      expect(isInternalUrl('http://127.0.0.1:3000/hook')).toBe(true);
    });

    it('should block private IP ranges', () => {
      expect(isInternalUrl('http://10.0.0.1/hook')).toBe(true);
      expect(isInternalUrl('http://172.16.0.1/hook')).toBe(true);
      expect(isInternalUrl('http://192.168.1.1/hook')).toBe(true);
    });

    it('should block link-local addresses', () => {
      expect(isInternalUrl('http://169.254.1.1/hook')).toBe(true);
    });

    it('should allow public URLs', () => {
      expect(isInternalUrl('https://webhook.example.com/hook')).toBe(false);
      expect(isInternalUrl('https://api.github.com/webhooks')).toBe(false);
    });

    it('should block invalid URLs', () => {
      expect(isInternalUrl('not-a-url')).toBe(true);
    });
  });

  describe('getDefaultVisibility', () => {
    it('should return private when to is set but no inReplyTo', () => {
      expect(getDefaultVisibility(['@alice'], undefined)).toBe('private');
      expect(getDefaultVisibility(['@alice', '@bob'], undefined)).toBe('private');
    });

    it('should return public when inReplyTo is set (reply)', () => {
      expect(getDefaultVisibility(['@alice'], 'entry123')).toBe('public');
    });

    it('should return public when neither to nor inReplyTo is set', () => {
      expect(getDefaultVisibility(undefined, undefined)).toBe('public');
      expect(getDefaultVisibility([], undefined)).toBe('public');
    });
  });

  describe('canViewEntry', () => {
    it('should allow authors to see their own entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'author',
        client: 'desktop' as const,
        content: 'Private message',
        timestamp: Date.now(),
        visibility: 'private' as const,
        to: ['@recipient'],
      };

      expect(canViewEntry(entry, 'author', undefined, true)).toBe(true);
    });

    it('should allow everyone to see public entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'Public post',
        timestamp: Date.now(),
        visibility: 'public' as const,
      };

      expect(canViewEntry(entry, undefined, undefined, false)).toBe(true);
      expect(canViewEntry(entry, 'randomuser', undefined, false)).toBe(true);
    });

    it('should allow everyone to see ai-only entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'AI only post',
        timestamp: Date.now(),
        visibility: 'ai-only' as const,
      };

      expect(canViewEntry(entry, undefined, undefined, false)).toBe(true);
    });

    it('should only allow recipients to see private entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'sender',
        client: 'desktop' as const,
        content: 'Private message',
        timestamp: Date.now(),
        visibility: 'private' as const,
        to: ['@alice', 'bob@example.com'],
      };

      // Recipients can see
      expect(canViewEntry(entry, 'alice', undefined, false)).toBe(true);
      expect(canViewEntry(entry, undefined, 'bob@example.com', false)).toBe(true);

      // Non-recipients cannot see
      expect(canViewEntry(entry, 'charlie', undefined, false)).toBe(false);
      expect(canViewEntry(entry, undefined, 'charlie@example.com', false)).toBe(false);
      expect(canViewEntry(entry, undefined, undefined, false)).toBe(false);
    });

    it('should handle case-insensitive email matching', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'Private message',
        timestamp: Date.now(),
        visibility: 'private' as const,
        to: ['Bob@Example.Com'],
      };

      expect(canViewEntry(entry, undefined, 'bob@example.com', false)).toBe(true);
      expect(canViewEntry(entry, undefined, 'BOB@EXAMPLE.COM', false)).toBe(true);
    });

    it('should default to public visibility when not specified', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'No visibility set',
        timestamp: Date.now(),
      };

      expect(canViewEntry(entry, undefined, undefined, false)).toBe(true);
    });
  });
});

describe('MemoryStorage getUserByEmail', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: hashSecretKey('alice-secret-key-1234567890'),
      email: 'alice@example.com',
    });
    await storage.createUser({
      handle: 'bob',
      secretKeyHash: hashSecretKey('bob-secret-key-1234567890'),
      email: 'Bob@Example.Com', // Mixed case
    });
    await storage.createUser({
      handle: 'noemail',
      secretKeyHash: hashSecretKey('noemail-secret-key-1234567890'),
    });
  });

  it('should find user by exact email', async () => {
    const user = await storage.getUserByEmail('alice@example.com');
    expect(user).toBeDefined();
    expect(user!.handle).toBe('alice');
  });

  it('should find user by email case-insensitively', async () => {
    const user = await storage.getUserByEmail('ALICE@EXAMPLE.COM');
    expect(user).toBeDefined();
    expect(user!.handle).toBe('alice');
  });

  it('should find user with mixed case stored email', async () => {
    const user = await storage.getUserByEmail('bob@example.com');
    expect(user).toBeDefined();
    expect(user!.handle).toBe('bob');
  });

  it('should return null for unknown email', async () => {
    const user = await storage.getUserByEmail('unknown@example.com');
    expect(user).toBeNull();
  });
});

describe('MemoryStorage getEntriesAddressedTo', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
  });

  it('should find entries addressed to @handle', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message to alice',
      timestamp: Date.now(),
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message to bob',
      timestamp: Date.now(),
      to: ['@bob'],
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Message to alice');
  });

  it('should find entries addressed to email', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message by email',
      timestamp: Date.now(),
      to: ['alice@example.com'],
    });

    const entries = await storage.getEntriesAddressedTo('alice', 'alice@example.com');
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Message by email');
  });

  it('should find entries addressed to either handle or email', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'By handle',
      timestamp: Date.now() - 1000,
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'By email',
      timestamp: Date.now(),
      to: ['alice@example.com'],
    });

    const entries = await storage.getEntriesAddressedTo('alice', 'alice@example.com');
    expect(entries).toHaveLength(2);
  });

  it('should return empty array when no entries addressed to user', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message to bob',
      timestamp: Date.now(),
      to: ['@bob'],
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries).toHaveLength(0);
  });

  it('should return entries sorted by timestamp descending', async () => {
    const now = Date.now();
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Oldest',
      timestamp: now - 2000,
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Newest',
      timestamp: now,
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Middle',
      timestamp: now - 1000,
      to: ['@alice'],
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries[0].content).toBe('Newest');
    expect(entries[1].content).toBe('Middle');
    expect(entries[2].content).toBe('Oldest');
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await storage.addEntry({
        pseudonym: 'Sender#123',
        client: 'desktop',
        content: `Message ${i}`,
        timestamp: Date.now() + i,
        to: ['@alice'],
      });
    }

    const entries = await storage.getEntriesAddressedTo('alice', undefined, 5);
    expect(entries).toHaveLength(5);
  });

  it('should not return entries without to field', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Public post (no to)',
      timestamp: Date.now(),
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries).toHaveLength(0);
  });
});

describe('MemoryStorage getRepliesTo', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
  });

  it('should find replies to an entry', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original post',
      timestamp: Date.now(),
    });

    await storage.addEntry({
      pseudonym: 'Replier#456',
      client: 'desktop',
      content: 'This is a reply',
      timestamp: Date.now() + 1000,
      inReplyTo: parent.id,
    });

    const replies = await storage.getRepliesTo(parent.id);
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toBe('This is a reply');
    expect(replies[0].inReplyTo).toBe(parent.id);
  });

  it('should return empty array for entry with no replies', async () => {
    const entry = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'No replies here',
      timestamp: Date.now(),
    });

    const replies = await storage.getRepliesTo(entry.id);
    expect(replies).toHaveLength(0);
  });

  it('should return replies sorted by timestamp ascending (oldest first)', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original',
      timestamp: Date.now(),
    });

    const now = Date.now();
    await storage.addEntry({
      pseudonym: 'Replier#1',
      client: 'desktop',
      content: 'Third reply',
      timestamp: now + 3000,
      inReplyTo: parent.id,
    });
    await storage.addEntry({
      pseudonym: 'Replier#2',
      client: 'desktop',
      content: 'First reply',
      timestamp: now + 1000,
      inReplyTo: parent.id,
    });
    await storage.addEntry({
      pseudonym: 'Replier#3',
      client: 'desktop',
      content: 'Second reply',
      timestamp: now + 2000,
      inReplyTo: parent.id,
    });

    const replies = await storage.getRepliesTo(parent.id);
    expect(replies).toHaveLength(3);
    expect(replies[0].content).toBe('First reply');
    expect(replies[1].content).toBe('Second reply');
    expect(replies[2].content).toBe('Third reply');
  });

  it('should only return direct replies, not replies to replies', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original',
      timestamp: Date.now(),
    });

    const reply = await storage.addEntry({
      pseudonym: 'Replier#1',
      client: 'desktop',
      content: 'Direct reply',
      timestamp: Date.now() + 1000,
      inReplyTo: parent.id,
    });

    await storage.addEntry({
      pseudonym: 'Replier#2',
      client: 'desktop',
      content: 'Reply to reply',
      timestamp: Date.now() + 2000,
      inReplyTo: reply.id,
    });

    const parentReplies = await storage.getRepliesTo(parent.id);
    expect(parentReplies).toHaveLength(1);
    expect(parentReplies[0].content).toBe('Direct reply');

    const nestedReplies = await storage.getRepliesTo(reply.id);
    expect(nestedReplies).toHaveLength(1);
    expect(nestedReplies[0].content).toBe('Reply to reply');
  });

  it('should respect limit parameter', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original',
      timestamp: Date.now(),
    });

    for (let i = 0; i < 10; i++) {
      await storage.addEntry({
        pseudonym: 'Replier#' + i,
        client: 'desktop',
        content: `Reply ${i}`,
        timestamp: Date.now() + i * 1000,
        inReplyTo: parent.id,
      });
    }

    const replies = await storage.getRepliesTo(parent.id, 5);
    expect(replies).toHaveLength(5);
  });
});

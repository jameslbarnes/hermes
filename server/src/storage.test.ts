import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage, StagedStorage } from './storage.js';
import { hashSecretKey } from './identity.js';

// Check if Firestore is configured
const hasFirestore = !!(
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  describe('User operations', () => {
    const testUser = {
      handle: 'testuser',
      secretKeyHash: hashSecretKey('test-secret-key-1234567890'),
      displayName: 'Test User',
      bio: 'A test user for testing',
      email: 'test@example.com',
    };

    describe('createUser', () => {
      it('should create a user and return it with createdAt', async () => {
        const user = await storage.createUser(testUser);

        expect(user.handle).toBe('testuser');
        expect(user.displayName).toBe('Test User');
        expect(user.bio).toBe('A test user for testing');
        expect(user.email).toBe('test@example.com');
        expect(user.secretKeyHash).toBe(testUser.secretKeyHash);
        expect(user.createdAt).toBeDefined();
        expect(typeof user.createdAt).toBe('number');
      });

      it('should store legacyPseudonym if provided', async () => {
        const userWithLegacy = {
          ...testUser,
          handle: 'legacyuser',
          legacyPseudonym: 'Quiet Feather#abc123',
        };
        const user = await storage.createUser(userWithLegacy);

        expect(user.legacyPseudonym).toBe('Quiet Feather#abc123');
      });
    });

    describe('getUser', () => {
      it('should retrieve a user by handle', async () => {
        await storage.createUser(testUser);
        const user = await storage.getUser('testuser');

        expect(user).toBeDefined();
        expect(user!.handle).toBe('testuser');
      });

      it('should return null for non-existent handle', async () => {
        const user = await storage.getUser('nonexistent');
        expect(user).toBeNull();
      });
    });

    describe('getUserByKeyHash', () => {
      it('should retrieve a user by their secret key hash', async () => {
        await storage.createUser(testUser);
        const user = await storage.getUserByKeyHash(testUser.secretKeyHash);

        expect(user).toBeDefined();
        expect(user!.handle).toBe('testuser');
      });

      it('should return null for non-existent key hash', async () => {
        const user = await storage.getUserByKeyHash('nonexistenthash');
        expect(user).toBeNull();
      });
    });

    describe('updateUser', () => {
      it('should update user fields', async () => {
        await storage.createUser(testUser);
        const updated = await storage.updateUser('testuser', {
          displayName: 'Updated Name',
          bio: 'Updated bio',
        });

        expect(updated).toBeDefined();
        expect(updated!.displayName).toBe('Updated Name');
        expect(updated!.bio).toBe('Updated bio');
        expect(updated!.email).toBe('test@example.com'); // unchanged
      });

      it('should return null when updating non-existent user', async () => {
        const updated = await storage.updateUser('nonexistent', { displayName: 'New' });
        expect(updated).toBeNull();
      });
    });

    describe('isHandleAvailable', () => {
      it('should return true for available handles', async () => {
        expect(await storage.isHandleAvailable('available')).toBe(true);
      });

      it('should return false for taken handles', async () => {
        await storage.createUser(testUser);
        expect(await storage.isHandleAvailable('testuser')).toBe(false);
      });
    });
  });

  describe('Entry operations with handles', () => {
    const testEntry = {
      pseudonym: 'Quiet Feather#abc123',
      client: 'desktop' as const,
      content: 'Test entry content',
      timestamp: Date.now(),
    };

    describe('addEntry with handle', () => {
      it('should store handle when provided', async () => {
        const entry = await storage.addEntry({
          ...testEntry,
          handle: 'testuser',
        });

        expect(entry.handle).toBe('testuser');
      });

      it('should work without handle (legacy behavior)', async () => {
        const entry = await storage.addEntry(testEntry);

        expect(entry.handle).toBeUndefined();
        expect(entry.pseudonym).toBe('Quiet Feather#abc123');
      });
    });

    describe('getEntriesByHandle', () => {
      it('should return entries for a specific handle', async () => {
        // Add entries with handles
        await storage.addEntry({ ...testEntry, handle: 'alice', content: 'Alice entry 1' });
        await storage.addEntry({ ...testEntry, handle: 'alice', content: 'Alice entry 2' });
        await storage.addEntry({ ...testEntry, handle: 'bob', content: 'Bob entry' });

        const aliceEntries = await storage.getEntriesByHandle('alice');

        expect(aliceEntries).toHaveLength(2);
        expect(aliceEntries.every(e => e.handle === 'alice')).toBe(true);
      });

      it('should return empty array for handle with no entries', async () => {
        const entries = await storage.getEntriesByHandle('nobody');
        expect(entries).toHaveLength(0);
      });

      it('should respect limit parameter', async () => {
        await storage.addEntry({ ...testEntry, handle: 'prolific', content: 'Entry 1' });
        await storage.addEntry({ ...testEntry, handle: 'prolific', content: 'Entry 2' });
        await storage.addEntry({ ...testEntry, handle: 'prolific', content: 'Entry 3' });

        const entries = await storage.getEntriesByHandle('prolific', 2);
        expect(entries).toHaveLength(2);
      });

      it('should return entries sorted by timestamp descending', async () => {
        const now = Date.now();
        await storage.addEntry({ ...testEntry, handle: 'chronological', timestamp: now - 2000 });
        await storage.addEntry({ ...testEntry, handle: 'chronological', timestamp: now });
        await storage.addEntry({ ...testEntry, handle: 'chronological', timestamp: now - 1000 });

        const entries = await storage.getEntriesByHandle('chronological');

        expect(entries[0].timestamp).toBe(now);
        expect(entries[1].timestamp).toBe(now - 1000);
        expect(entries[2].timestamp).toBe(now - 2000);
      });
    });

    describe('migrateEntriesToHandle', () => {
      it('should migrate entries from pseudonym to handle', async () => {
        const pseudonym = 'Migrating User#def456';

        // Add entries with just pseudonym (legacy)
        await storage.addEntry({ ...testEntry, pseudonym, content: 'Old entry 1' });
        await storage.addEntry({ ...testEntry, pseudonym, content: 'Old entry 2' });

        // Migrate to handle
        const count = await storage.migrateEntriesToHandle(pseudonym, 'newhandle');

        expect(count).toBe(2);

        // Verify entries now have the handle
        const entries = await storage.getEntriesByHandle('newhandle');
        expect(entries).toHaveLength(2);
        expect(entries.every(e => e.handle === 'newhandle')).toBe(true);
        // Pseudonym should be preserved
        expect(entries.every(e => e.pseudonym === pseudonym)).toBe(true);
      });

      it('should return 0 when no entries match the pseudonym', async () => {
        const count = await storage.migrateEntriesToHandle('Nonexistent#000000', 'handle');
        expect(count).toBe(0);
      });

      it('should not affect entries from other pseudonyms', async () => {
        await storage.addEntry({ ...testEntry, pseudonym: 'User A#111111', content: 'A entry' });
        await storage.addEntry({ ...testEntry, pseudonym: 'User B#222222', content: 'B entry' });

        await storage.migrateEntriesToHandle('User A#111111', 'usera');

        // User B's entry should be unaffected
        const allEntries = await storage.getEntries();
        const userBEntry = allEntries.find(e => e.pseudonym === 'User B#222222');
        expect(userBEntry).toBeDefined();
        expect(userBEntry!.handle).toBeUndefined();
      });
    });
  });

  describe('Basic entry operations', () => {
    it('should add and retrieve entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'Hello world',
        timestamp: Date.now(),
      });

      expect(entry.id).toBeDefined();
      expect(entry.content).toBe('Hello world');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
    });

    it('should delete entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'To be deleted',
        timestamp: Date.now(),
      });

      await storage.deleteEntry(entry.id);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(0);
    });

    it('should get entries by pseudonym', async () => {
      await storage.addEntry({
        pseudonym: 'User A#111',
        client: 'desktop',
        content: 'Entry from A',
        timestamp: Date.now(),
      });
      await storage.addEntry({
        pseudonym: 'User B#222',
        client: 'mobile',
        content: 'Entry from B',
        timestamp: Date.now(),
      });

      const entriesA = await storage.getEntriesByPseudonym('User A#111');
      expect(entriesA).toHaveLength(1);
      expect(entriesA[0].content).toBe('Entry from A');
    });
  });

  describe('Following', () => {
    const testUser = {
      handle: 'follower',
      secretKeyHash: hashSecretKey('follower-key-1234567890'),
      displayName: 'Follower',
    };

    const targetUser = {
      handle: 'target',
      secretKeyHash: hashSecretKey('target-key-1234567890'),
      displayName: 'Target User',
      bio: 'Builds things',
    };

    beforeEach(async () => {
      await storage.createUser(testUser);
      await storage.createUser(targetUser);
    });

    it('should default to undefined following', async () => {
      const user = await storage.getUser('follower');
      expect(user!.following).toBeUndefined();
    });

    it('should store following list with notes', async () => {
      const following = [
        { handle: 'target', note: 'Builds things, recent TEE work' },
      ];
      await storage.updateUser('follower', { following });

      const user = await storage.getUser('follower');
      expect(user!.following).toHaveLength(1);
      expect(user!.following![0].handle).toBe('target');
      expect(user!.following![0].note).toBe('Builds things, recent TEE work');
    });

    it('should add a follow to existing list', async () => {
      const thirdUser = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-1234567890'),
      };
      await storage.createUser(thirdUser);

      // Start with one follow
      await storage.updateUser('follower', {
        following: [{ handle: 'target', note: 'First follow' }],
      });

      // Add second follow
      const user = await storage.getUser('follower');
      const updated = [...(user!.following || []), { handle: 'alice', note: 'Second follow' }];
      await storage.updateUser('follower', { following: updated });

      const result = await storage.getUser('follower');
      expect(result!.following).toHaveLength(2);
      expect(result!.following![0].handle).toBe('target');
      expect(result!.following![1].handle).toBe('alice');
    });

    it('should remove a follow from the list', async () => {
      await storage.updateUser('follower', {
        following: [
          { handle: 'target', note: 'First' },
          { handle: 'other', note: 'Second' },
        ],
      });

      const user = await storage.getUser('follower');
      const filtered = user!.following!.filter(f => f.handle !== 'target');
      await storage.updateUser('follower', { following: filtered });

      const result = await storage.getUser('follower');
      expect(result!.following).toHaveLength(1);
      expect(result!.following![0].handle).toBe('other');
    });

    it('should update note for existing follow', async () => {
      await storage.updateUser('follower', {
        following: [{ handle: 'target', note: 'Original note' }],
      });

      const user = await storage.getUser('follower');
      const updated = user!.following!.map(f =>
        f.handle === 'target' ? { ...f, note: 'Updated note' } : f
      );
      await storage.updateUser('follower', { following: updated });

      const result = await storage.getUser('follower');
      expect(result!.following![0].note).toBe('Updated note');
    });

    it('should handle empty following list', async () => {
      await storage.updateUser('follower', { following: [] });

      const user = await storage.getUser('follower');
      expect(user!.following).toEqual([]);
    });
  });
});

// StagedStorage tests - require Firestore
describe.skipIf(!hasFirestore)('StagedStorage', () => {
  describe('Dynamic buffer time', () => {
    it('should use custom stagingDelayMs when provided', async () => {
      const defaultDelay = 60 * 60 * 1000; // 1 hour default
      const storage = new StagedStorage(defaultDelay);

      const customDelay = 2 * 60 * 60 * 1000; // 2 hours
      const before = Date.now();

      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'Test with custom delay',
        timestamp: before,
        handle: 'testuser',
      }, customDelay);

      const after = Date.now();

      // publishAt should be approximately now + customDelay
      expect(entry.publishAt).toBeDefined();
      expect(entry.publishAt).toBeGreaterThanOrEqual(before + customDelay);
      expect(entry.publishAt).toBeLessThanOrEqual(after + customDelay);
    });

    it('should use default delay when stagingDelayMs not provided', async () => {
      const defaultDelay = 60 * 60 * 1000; // 1 hour default
      const storage = new StagedStorage(defaultDelay);

      const before = Date.now();

      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'Test with default delay',
        timestamp: before,
        handle: 'testuser',
      });

      const after = Date.now();

      // publishAt should be approximately now + defaultDelay
      expect(entry.publishAt).toBeDefined();
      expect(entry.publishAt).toBeGreaterThanOrEqual(before + defaultDelay);
      expect(entry.publishAt).toBeLessThanOrEqual(after + defaultDelay);
    });

    it('should respect user-configured buffer times', async () => {
      const defaultDelay = 60 * 60 * 1000; // 1 hour
      const storage = new StagedStorage(defaultDelay);

      // Simulate different users with different buffer settings
      const shortBuffer = 2 * 60 * 60 * 1000;  // 2 hours
      const longBuffer = 24 * 60 * 60 * 1000;  // 24 hours

      const before = Date.now();

      const entry1 = await storage.addEntry({
        pseudonym: 'Short Buffer User#111',
        client: 'desktop',
        content: 'Quick publish',
        timestamp: before,
        handle: 'shortuser',
      }, shortBuffer);

      const entry2 = await storage.addEntry({
        pseudonym: 'Long Buffer User#222',
        client: 'desktop',
        content: 'Slow publish',
        timestamp: before,
        handle: 'longuser',
      }, longBuffer);

      // Verify different publishAt times
      expect(entry2.publishAt! - entry1.publishAt!).toBeGreaterThanOrEqual(longBuffer - shortBuffer - 100);
      expect(entry2.publishAt! - entry1.publishAt!).toBeLessThanOrEqual(longBuffer - shortBuffer + 100);
    });
  });
});

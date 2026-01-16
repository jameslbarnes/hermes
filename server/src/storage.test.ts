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

  describe('Comment operations', () => {
    describe('Entry-level comments', () => {
      it('should add a comment to an entry', async () => {
        const entry = await storage.addEntry({
          pseudonym: 'Author#123',
          client: 'desktop',
          content: 'Test entry',
          timestamp: Date.now(),
        });

        const comment = await storage.addComment({
          entryId: entry.id,
          handle: 'commenter',
          content: 'Great post!',
          timestamp: Date.now(),
        });

        expect(comment.id).toBeDefined();
        expect(comment.entryId).toBe(entry.id);
        expect(comment.handle).toBe('commenter');
        expect(comment.content).toBe('Great post!');
      });

      it('should retrieve comments for an entry', async () => {
        const entry = await storage.addEntry({
          pseudonym: 'Author#123',
          client: 'desktop',
          content: 'Test entry',
          timestamp: Date.now(),
        });

        await storage.addComment({
          entryId: entry.id,
          handle: 'user1',
          content: 'Comment 1',
          timestamp: Date.now(),
        });
        await storage.addComment({
          entryId: entry.id,
          handle: 'user2',
          content: 'Comment 2',
          timestamp: Date.now() + 1000,
        });

        const comments = await storage.getCommentsForEntry(entry.id);
        expect(comments).toHaveLength(2);
        expect(comments[0].content).toBe('Comment 1');
        expect(comments[1].content).toBe('Comment 2');
      });

      it('should return empty array for entry with no comments', async () => {
        const comments = await storage.getCommentsForEntry('nonexistent');
        expect(comments).toHaveLength(0);
      });
    });

    describe('Summary-level comments', () => {
      it('should add a comment to a summary', async () => {
        const comment = await storage.addComment({
          summaryId: 'summary-123',
          handle: 'commenter',
          content: 'Great session!',
          timestamp: Date.now(),
        });

        expect(comment.id).toBeDefined();
        expect(comment.summaryId).toBe('summary-123');
        expect(comment.entryId).toBeUndefined();
        expect(comment.handle).toBe('commenter');
      });

      it('should retrieve comments for a summary', async () => {
        await storage.addComment({
          summaryId: 'summary-456',
          handle: 'user1',
          content: 'Summary comment 1',
          timestamp: Date.now(),
        });
        await storage.addComment({
          summaryId: 'summary-456',
          handle: 'user2',
          content: 'Summary comment 2',
          timestamp: Date.now() + 1000,
        });

        const comments = await storage.getCommentsForSummary('summary-456');
        expect(comments).toHaveLength(2);
        expect(comments[0].content).toBe('Summary comment 1');
        expect(comments[1].content).toBe('Summary comment 2');
      });

      it('should return empty array for summary with no comments', async () => {
        const comments = await storage.getCommentsForSummary('nonexistent');
        expect(comments).toHaveLength(0);
      });

      it('should keep entry and summary comments separate', async () => {
        // Add entry comment
        await storage.addComment({
          entryId: 'entry-1',
          handle: 'user1',
          content: 'Entry comment',
          timestamp: Date.now(),
        });
        // Add summary comment
        await storage.addComment({
          summaryId: 'summary-1',
          handle: 'user2',
          content: 'Summary comment',
          timestamp: Date.now(),
        });

        const entryComments = await storage.getCommentsForEntry('entry-1');
        const summaryComments = await storage.getCommentsForSummary('summary-1');

        expect(entryComments).toHaveLength(1);
        expect(entryComments[0].content).toBe('Entry comment');
        expect(summaryComments).toHaveLength(1);
        expect(summaryComments[0].content).toBe('Summary comment');
      });
    });

    describe('Comment deletion', () => {
      it('should delete a comment', async () => {
        const comment = await storage.addComment({
          entryId: 'entry-1',
          handle: 'user1',
          content: 'To be deleted',
          timestamp: Date.now(),
        });

        await storage.deleteComment(comment.id);

        const comments = await storage.getCommentsForEntry('entry-1');
        expect(comments).toHaveLength(0);
      });
    });

    describe('getCommentById', () => {
      it('should retrieve a comment by ID', async () => {
        const comment = await storage.addComment({
          entryId: 'entry-1',
          handle: 'user1',
          content: 'Test comment',
          timestamp: Date.now(),
        });

        const retrieved = await storage.getCommentById(comment.id);
        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe(comment.id);
        expect(retrieved!.content).toBe('Test comment');
      });

      it('should return null for non-existent comment ID', async () => {
        const retrieved = await storage.getCommentById('nonexistent-id');
        expect(retrieved).toBeNull();
      });
    });

    describe('getCommentsByHandle', () => {
      it('should retrieve comments by handle', async () => {
        await storage.addComment({
          entryId: 'entry-1',
          handle: 'prolific-commenter',
          content: 'Comment 1',
          timestamp: Date.now(),
        });
        await storage.addComment({
          summaryId: 'summary-1',
          handle: 'prolific-commenter',
          content: 'Comment 2',
          timestamp: Date.now() + 1000,
        });
        await storage.addComment({
          entryId: 'entry-2',
          handle: 'other-user',
          content: 'Other comment',
          timestamp: Date.now(),
        });

        const comments = await storage.getCommentsByHandle('prolific-commenter');
        expect(comments).toHaveLength(2);
        expect(comments.every(c => c.handle === 'prolific-commenter')).toBe(true);
      });
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

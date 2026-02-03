import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createNotificationService, type EmailClient } from './notifications.js';
import { MemoryStorage, type User, type JournalEntry } from './storage.js';
import { hashSecretKey } from './identity.js';

function createMockEmailClient(): EmailClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async send(params) {
      calls.push(params);
    },
  };
}

describe('NotificationService', () => {
  let storage: MemoryStorage;
  let emailClient: ReturnType<typeof createMockEmailClient>;
  let service: ReturnType<typeof createNotificationService>;

  beforeEach(async () => {
    storage = new MemoryStorage();
    emailClient = createMockEmailClient();
    service = createNotificationService({
      storage,
      emailClient,
      anthropic: null,
      fromEmail: 'notify@hermes.test',
      baseUrl: 'https://hermes.test',
      jwtSecret: 'test-secret',
    });
  });

  describe('notifyNewFollower', () => {
    it('should send email when followed user has verified email', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        bio: 'Building things',
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].to).toBe('bob@example.com');
      expect(emailClient.calls[0].subject).toBe('@alice started following you');
      expect(emailClient.calls[0].html).toContain('@alice');
      expect(emailClient.calls[0].html).toContain('Building things');
    });

    it('should skip when followed user has no verified email', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: false,
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(0);
    });

    it('should skip when followed user has no email', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(0);
    });

    it('should skip when followed user disabled notifications', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        emailPrefs: { comments: false, digest: true },
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(0);
    });

    it('should not include bio section when follower has no bio', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].html).not.toContain('Their bio');
    });
  });

  describe('notifyAddressedEntry with author CC', () => {
    it('should CC author when author has verified email', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const author: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hey Bob, check this out',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient, author);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].to).toBe('bob@example.com');
      expect(emailClient.calls[0].cc).toBe('alice@example.com');
      expect(emailClient.calls[0].replyTo).toBe('alice@example.com');
    });

    it('should not CC author when author has no verified email', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const author: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: false,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hey Bob',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient, author);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].cc).toBeUndefined();
      expect(emailClient.calls[0].replyTo).toBeUndefined();
    });

    it('should not CC when no author provided', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hey Bob',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].cc).toBeUndefined();
    });

    it('should use warm subject line', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hello',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient);

      expect(emailClient.calls[0].subject).toBe('@alice wrote you something');
    });

    it('should use warm template with quote style', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hello world',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient);

      const html = emailClient.calls[0].html;
      expect(html).toContain('Hey,');
      expect(html).toContain('wrote this for you');
      expect(html).toContain('class="quote"');
      expect(html).toContain('hermes.teleport.computer');
      // Should NOT have old platform-style copy
      expect(html).not.toContain("You're receiving this because");
    });
  });

  describe('sendVerificationEmail', () => {
    it('should use warm template', async () => {
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
      });

      await service.sendVerificationEmail('alice', 'alice@example.com');

      expect(emailClient.calls).toHaveLength(1);
      const html = emailClient.calls[0].html;
      expect(html).toContain('Hey @alice');
      expect(html).toContain('verify your email');
      expect(html).toContain('hermes.teleport.computer');
      // Should NOT have old style
      expect(html).not.toContain("If you didn't request this");
    });
  });
});

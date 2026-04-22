import { describe, it, expect, beforeEach } from 'vitest';
import { detectSparks, getConnectionInfo } from './sparks.js';
import { MemoryStorage } from '../storage.js';
import type { JournalEntry } from '../storage.js';

describe('detectSparks', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('returns empty array when source entry has no handle', async () => {
    const entry: JournalEntry = {
      id: '1',
      pseudonym: 'Anon#abc',
      client: 'desktop',
      content: 'test',
      timestamp: Date.now(),
    };
    const sparks = await detectSparks(entry, storage);
    expect(sparks).toEqual([]);
  });

  it('returns empty when no search terms available', async () => {
    const entry: JournalEntry = {
      id: '1',
      handle: 'alice',
      pseudonym: 'Alice#abc',
      client: 'desktop',
      content: 'test',
      timestamp: Date.now(),
    };
    const sparks = await detectSparks(entry, storage);
    expect(sparks).toEqual([]);
  });

  it('finds candidates with overlapping topics', async () => {
    // Bob writes about TEE attestation
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-bob' });
    await storage.addEntry({
      handle: 'bob',
      pseudonym: 'Bob#001',
      client: 'desktop',
      content: 'Working on TEE attestation and enclave key rotation patterns for ML model signing.',
      timestamp: Date.now() - 1000,
      keywords: ['tee', 'attestation', 'enclave', 'ml'],
      topicHints: ['tee-attestation'],
    });

    // Alice writes about the same topic
    const aliceEntry = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'Exploring TEE attestation for ML provenance.',
      timestamp: Date.now(),
      keywords: ['tee', 'attestation', 'provenance'],
      topicHints: ['tee-attestation'],
    });

    const sparks = await detectSparks(aliceEntry, storage);
    expect(sparks.length).toBeGreaterThan(0);
    expect(sparks.map(s => s.handle)).toContain('bob');
  });

  it('excludes the source author from candidates', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-alice' });

    const entry1 = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'First entry about TEE.',
      timestamp: Date.now() - 1000,
      keywords: ['tee'],
    });

    const entry2 = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'Second entry about TEE.',
      timestamp: Date.now(),
      keywords: ['tee'],
      topicHints: ['tee'],
    });

    const sparks = await detectSparks(entry2, storage);
    expect(sparks.every(s => s.handle !== 'alice')).toBe(true);
  });

  it('excludes AI-only entries from candidates', async () => {
    await storage.addEntry({
      handle: 'bob',
      pseudonym: 'Bob#001',
      client: 'desktop',
      content: 'AI-only entry about TEE.',
      timestamp: Date.now() - 1000,
      keywords: ['tee'],
      topicHints: ['tee'],
      aiOnly: true,
    });

    const aliceEntry = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'Public entry about TEE.',
      timestamp: Date.now(),
      keywords: ['tee'],
      topicHints: ['tee'],
    });

    const sparks = await detectSparks(aliceEntry, storage);
    expect(sparks.every(s => s.handle !== 'bob')).toBe(true);
  });
});

describe('getConnectionInfo', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('returns not-connected for users with no relationship', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(false);
    expect(info.sharedRoomIds).toEqual([]);
  });

  it('detects connection when users share a channel', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });
    await storage.createChannel({
      id: 'tees',
      name: 'TEEs',
      visibility: 'public',
      createdBy: 'alice',
      createdAt: Date.now(),
      skills: [],
      subscribers: [],
    } as any);
    await storage.addSubscriber('tees', 'alice', 'admin');
    await storage.addSubscriber('tees', 'bob', 'member');

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(true);
    expect(info.recentInteractions).toBeGreaterThan(0);
  });

  it('detects connection via mutual follows', async () => {
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-a',
      following: [{ handle: 'bob', note: 'works on TEE' }],
    });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(true);
  });

  it('detects connection via addressed entries', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });
    await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#abc',
      client: 'desktop',
      content: 'Message for bob',
      timestamp: Date.now(),
      to: ['@bob'],
    });

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(true);
  });
});

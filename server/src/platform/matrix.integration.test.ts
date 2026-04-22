/**
 * Matrix Platform Integration Tests
 *
 * These tests require a running Matrix homeserver. They:
 * - Skip automatically if MATRIX_SERVER_URL is not set
 * - Register a test bot, bootstrap cross-signing, verify keys are on the server
 * - Create rooms (encrypted), send messages, verify delivery
 *
 * To run: MATRIX_SERVER_URL=http://localhost:8008 MATRIX_SERVER_NAME=localhost MATRIX_REGISTRATION_TOKEN=router-dev-token npm test matrix.integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MatrixPlatform } from './matrix.js';

const MATRIX_SERVER_URL = process.env.MATRIX_SERVER_URL;
const MATRIX_SERVER_NAME = process.env.MATRIX_SERVER_NAME;
const MATRIX_REGISTRATION_TOKEN = process.env.MATRIX_REGISTRATION_TOKEN;

const shouldRun = !!(MATRIX_SERVER_URL && MATRIX_SERVER_NAME && MATRIX_REGISTRATION_TOKEN);

describe.skipIf(!shouldRun)('MatrixPlatform integration', () => {
  let platform: MatrixPlatform;
  const botHandle = `test-router-${Date.now().toString(36).slice(-6)}`;
  const botSecret = `test-secret-${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    platform = new MatrixPlatform({
      serverUrl: MATRIX_SERVER_URL!,
      serverName: MATRIX_SERVER_NAME!,
      botSecretKey: botSecret,
      botHandle,
      registrationToken: MATRIX_REGISTRATION_TOKEN,
    });
    await platform.start();
    // Give bootstrap time to complete
    await new Promise(r => setTimeout(r, 5000));
  }, 60000);

  afterAll(async () => {
    if (platform) await platform.stop();
  });

  describe('identity', () => {
    it('resolves Hermes handle from Matrix user ID', async () => {
      const handle = await platform.resolveHermesHandle(`@alice:${MATRIX_SERVER_NAME}`);
      expect(handle).toBe('alice');
    });

    it('resolves platform ID from Hermes handle', async () => {
      const id = await platform.resolvePlatformId('alice');
      expect(id).toBe(`@alice:${MATRIX_SERVER_NAME}`);
    });
  });

  describe('crypto bootstrap', () => {
    it('uploads cross-signing keys (master, self-signing, user-signing) to the server', async () => {
      // Query the server for the bot's keys
      const loginResp = await fetch(`${MATRIX_SERVER_URL}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: botHandle },
          password: require('crypto').createHmac('sha256', botSecret)
            .update(`matrix:${MATRIX_SERVER_NAME}`).digest('base64url'),
        }),
      });
      const loginData = await loginResp.json() as any;
      const token = loginData.access_token;
      const userId = loginData.user_id;

      const keysResp = await fetch(`${MATRIX_SERVER_URL}/_matrix/client/v3/keys/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ device_keys: { [userId]: [] } }),
      });
      const keys = await keysResp.json() as any;

      expect(keys.master_keys?.[userId]).toBeDefined();
      expect(keys.self_signing_keys?.[userId]).toBeDefined();
      expect(keys.user_signing_keys?.[userId]).toBeDefined();
    }, 30000);
  });

  describe('channel rooms', () => {
    it('creates a channel room when ensureChannelRoom is called', async () => {
      const channelId = `test-${Date.now().toString(36).slice(-6)}`;
      const roomId = await platform.ensureChannelRoom(channelId, 'Test Channel', 'For testing');
      expect(roomId).toMatch(/^!/);
      expect(roomId.length).toBeGreaterThan(5);
    }, 30000);

    it('returns the same room ID for the same channel (cached)', async () => {
      const channelId = `test-cache-${Date.now().toString(36).slice(-6)}`;
      const id1 = await platform.ensureChannelRoom(channelId, 'Cache Test');
      const id2 = await platform.ensureChannelRoom(channelId, 'Cache Test');
      expect(id1).toBe(id2);
    }, 30000);
  });

  describe('messaging', () => {
    it('sends a message to a room and returns an event ID', async () => {
      const channelId = `test-msg-${Date.now().toString(36).slice(-6)}`;
      const roomId = await platform.ensureChannelRoom(channelId, 'Message Test');

      const eventId = await platform.sendMessage(roomId, 'Hello from test');
      expect(eventId).toMatch(/^\$/);
    }, 30000);

    it('posts entry events with custom fields', async () => {
      const channelId = `test-entry-${Date.now().toString(36).slice(-6)}`;
      const roomId = await platform.ensureChannelRoom(channelId, 'Entry Test');

      const eventId = await platform.postEntry(roomId, {
        id: 'test-entry-1',
        handle: 'alice',
        pseudonym: 'Alice#abc',
        content: 'Test entry content',
        timestamp: Date.now(),
        topicHints: ['test'],
      }, 'Editorial hook for this entry');

      expect(eventId).toMatch(/^\$/);
    }, 30000);
  });
});

describe('MatrixPlatform interface contract', () => {
  it('exports expected constants for custom event types', async () => {
    const mod = await import('./matrix.js');
    expect(mod.ROUTER_ENTRY_EVENT).toBe('com.router.entry');
    expect(mod.ROUTER_SPARK_EVENT).toBe('com.router.spark');
    expect(mod.ROUTER_DIGEST_EVENT).toBe('com.router.digest');
    expect(mod.ROUTER_CHANNEL_STATE).toBe('com.router.channel');
  });

  it('has the expected Platform interface shape', () => {
    const platform = new MatrixPlatform({
      serverUrl: 'http://example',
      serverName: 'example',
      botSecretKey: 'test',
      botHandle: 'bot',
    });

    expect(platform.name).toBe('matrix');
    expect(platform.maxMessageLength).toBe(65536);
    expect(typeof platform.start).toBe('function');
    expect(typeof platform.stop).toBe('function');
    expect(typeof platform.sendMessage).toBe('function');
    expect(typeof platform.createRoom).toBe('function');
    expect(typeof platform.inviteToRoom).toBe('function');
    expect(typeof platform.setRoomTopic).toBe('function');
    expect(typeof platform.resolveHermesHandle).toBe('function');
    expect(typeof platform.resolvePlatformId).toBe('function');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouterEvent } from './events.js';
import type { MatrixHistoryMessage } from './platform/matrix.js';

const anthropicCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: anthropicCreateMock };
  },
}));

import {
  buildProvenanceContent,
  buildRoomSummary,
  firstWord,
  handleMention,
  hasSeenMessage,
  initializeRuntimeCursor,
  matrixBotSecretKey,
  matrixMessageLine,
  normalizeTag,
  relativeSinceMs,
  remember,
  rememberMessage,
  startShapeMatrixService,
  stripBotAddressing,
  type BridgeState,
} from './shape-matrix-bridge.js';

async function withShapeMatrixService(matrix: any, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await startShapeMatrixService(matrix, {
    host: '127.0.0.1',
    port: 0,
    serviceKey: 'test-service-key',
  });
  if (!server) throw new Error('test service did not start');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test service did not bind to a TCP port');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('Shape Matrix bridge helpers', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MATRIX_ACCESS_TOKEN;
    delete process.env.MATRIX_BOT_HANDLE;
    delete process.env.MATRIX_BOT_SECRET_KEY;
    delete process.env.SHAPE_MATRIX_SUMMARY_WINDOW_MS;
    delete process.env.SHAPE_MATRIX_REQUIRE_SPACE_MEMBERSHIP_FOR_PROVISION;
    delete process.env.SHAPE_ROUTER_SECRET_KEY;
    delete process.env.SHAPE_ROUTER_BASE_URL;
    delete process.env.SHAPE_MATRIX_AGENT_URL;
    delete process.env.SHAPE_MATRIX_AGENT_SECRET;
    delete process.env.SHAPE_MATRIX_AGENT_TIMEOUT_MS;
    delete process.env.SHAPE_MATRIX_SERVICE_HOST;
    delete process.env.SHAPE_MATRIX_SERVICE_KEY;
    delete process.env.SHAPE_MATRIX_SERVICE_PORT;
    anthropicCreateMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('normalizes private Router tags without introducing invalid characters', () => {
    expect(normalizeTag(' #Shape Rotator! ')).toBe('shape-rotator');
    expect(normalizeTag('Matrix:Summary')).toBe('matrix:summary');
    expect(normalizeTag('---')).toBe('');
  });

  it('parses bridge commands and strips bot addressing', () => {
    process.env.MATRIX_BOT_HANDLE = 'router';
    expect(firstWord('/search router history')).toBe('search');
    expect(stripBotAddressing('@router search private notes')).toBe('search private notes');
    expect(stripBotAddressing('@alice:matrix.org @router help')).toBe('help');
    expect(stripBotAddressing('<@alice.smith:matrix.org> @router help')).toBe('help');

    process.env.MATRIX_BOT_HANDLE = 'router.bot';
    expect(stripBotAddressing('@router.bot search private notes')).toBe('search private notes');
  });

  it('prefers Matrix access-token mode over stale bot-secret env', () => {
    process.env.MATRIX_ACCESS_TOKEN = 'access-token';
    process.env.MATRIX_BOT_SECRET_KEY = 'stale-password-secret';
    expect(matrixBotSecretKey()).toBeUndefined();
  });

  it('requires service auth for the private Router Matrix service', async () => {
    const matrix = {
      sendMessageContent: vi.fn(async () => '$event'),
    };

    await withShapeMatrixService(matrix, async baseUrl => {
      const response = await fetch(`${baseUrl}/rooms/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: '!room:mtrx.test', text: 'hello' }),
      });

      expect(response.status).toBe(401);
      expect(matrix.sendMessageContent).not.toHaveBeenCalled();
    });
  });

  it('forwards Matrix room message content through the E2EE bridge service', async () => {
    const matrix = {
      sendMessageContent: vi.fn(async () => '$encrypted'),
    };
    const content = {
      msgtype: 'm.text',
      body: 'James Barnes (@specularist): linked entry',
      'm.mentions': { user_ids: ['@specularist:matrix.org'] },
      author_display_name: 'James Barnes',
      author_matrix_user_id: '@specularist:matrix.org',
    };

    await withShapeMatrixService(matrix, async baseUrl => {
      const response = await fetch(`${baseUrl}/rooms/message?key=test-service-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: '!botnoise:mtrx.test',
          text: 'fallback text',
          content,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ event_id: '$encrypted' });
      expect(matrix.sendMessageContent).toHaveBeenCalledWith('!botnoise:mtrx.test', content);
    });
  });

  it('exposes recent messages with private Router spark debounce options', async () => {
    const matrix = {
      queryRecentMessages: vi.fn(async () => [{
        roomId: '!room:mtrx.test',
        roomName: 'Bot Noise',
        senderId: '@router:mtrx.test',
        text: 'hello',
        timestamp: 123,
        isDM: false,
      }]),
    };

    await withShapeMatrixService(matrix, async baseUrl => {
      const response = await fetch(`${baseUrl}/recent-messages?key=test-service-key&since=100&limit=5&per_room_limit=2`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        messages: [{ roomId: '!room:mtrx.test', text: 'hello' }],
      });
      expect(matrix.queryRecentMessages).toHaveBeenCalledWith({
        since: 100,
        limit: 5,
        perRoomLimit: 2,
        botScope: true,
      });
    });
  });

  it('exposes authenticated Matrix event snapshots for live mirror verification', async () => {
    const matrix = {
      getRoomEventSnapshot: vi.fn(async () => ({
        roomId: '!botnoise:mtrx.test',
        eventId: '$event',
        sender: '@router:mtrx.test',
        type: 'm.room.message',
        wireType: 'm.room.encrypted',
        content: {
          body: 'James Barnes (@specularist): linked entry',
          author_matrix_user_id: '@specularist:matrix.org',
          'm.mentions': { user_ids: ['@specularist:matrix.org'] },
        },
      })),
    };

    await withShapeMatrixService(matrix, async baseUrl => {
      const response = await fetch(`${baseUrl}/rooms/event?key=test-service-key&room_id=${encodeURIComponent('!botnoise:mtrx.test')}&event_id=${encodeURIComponent('$event')}`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        sender: '@router:mtrx.test',
        wireType: 'm.room.encrypted',
        content: { author_matrix_user_id: '@specularist:matrix.org' },
      });
      expect(matrix.getRoomEventSnapshot).toHaveBeenCalledWith('!botnoise:mtrx.test', '$event');
    });
  });

  it('parses summary windows from Matrix text', () => {
    expect(relativeSinceMs('summarize this room 15m')).toBe(15 * 60 * 1000);
    expect(relativeSinceMs('summarize this room 7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(relativeSinceMs('summarize this week')).toBe(7 * 24 * 60 * 60 * 1000);
    process.env.SHAPE_MATRIX_SUMMARY_WINDOW_MS = '12345';
    expect(relativeSinceMs('summarize this room')).toBe(12345);
  });

  it('keeps a bounded duplicate-message memory for restart safety', () => {
    const state: BridgeState = { cursor: 0, initialized: true };
    expect(hasSeenMessage(state, '$a')).toBe(false);
    rememberMessage(state, '$a');
    expect(hasSeenMessage(state, '$a')).toBe(true);
    expect(remember(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
  });

  it('treats the event cursor as process-local after restart', () => {
    const state: BridgeState = {
      cursor: 100,
      initialized: true,
      handledMatrixMessageIds: ['$already-saved'],
    };

    const cursor = initializeRuntimeCursor(state, 0);

    expect(cursor).toBe(0);
    expect(state.cursor).toBe(0);
    expect(state.initialized).toBe(true);
    expect(state.handledMatrixMessageIds).toEqual(['$already-saved']);
  });

  it('renders Matrix provenance into saved private Router entries', () => {
    const event: RouterEvent = {
      id: 1,
      type: 'platform_mention',
      timestamp: 10,
      data: {
        platform: 'matrix',
        room_id: '!room:matrix.test',
        message_id: '$msg',
        sender_id: '@alice:matrix.test',
        sender_handle: 'alice',
        is_dm: false,
      },
    };

    const content = buildProvenanceContent(event, 'Decision: use private Router.');
    expect(content).toContain('Source: Matrix room');
    expect(content).toContain('Room ID: !room:matrix.test');
    expect(content).toContain('Matrix event: $msg');
    expect(content).toContain('Organizer: @alice');
    expect(content).toContain('Decision: use private Router.');
  });

  it('builds extractive room summaries when no Anthropic key is configured', async () => {
    const messages: MatrixHistoryMessage[] = [
      {
        roomId: '!room:matrix.test',
        roomName: 'Shape General',
        senderId: '@alice:matrix.test',
        senderHandle: 'alice',
        text: 'We should save this in private Router.',
        timestamp: Date.parse('2026-05-16T12:00:00Z'),
        isDM: false,
      },
      {
        roomId: '!room:matrix.test',
        roomName: 'Shape General',
        senderId: '@bob:matrix.test',
        senderHandle: 'bob',
        text: 'Agreed, and the public board should only get the digest.',
        timestamp: Date.parse('2026-05-16T12:05:00Z'),
        isDM: false,
      },
    ];

    expect(matrixMessageLine(messages[0])).toContain('@alice: We should save this');
    const built = await buildRoomSummary([...messages].reverse(), 60 * 60 * 1000);
    expect(built.summary).toContain('Captured 2 Matrix messages from 2 participants');
    expect(built.content).toContain('Source: Matrix room "Shape General"');
    expect(built.content).toContain('Participants: @alice, @bob');
    expect(built.content.indexOf('@alice')).toBeLessThan(built.content.indexOf('@bob'));
    expect(built.content).toContain('public board should only get the digest');
  });

  it('keeps source Matrix messages in room summaries when Anthropic summaries are enabled', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'LLM summary intentionally omits the smoke phrase.' }],
    });

    const messages: MatrixHistoryMessage[] = [
      {
        roomId: '!room:matrix.test',
        roomName: 'Shape General',
        senderId: '@alice:matrix.test',
        senderHandle: 'alice',
        text: 'shape-matrix-live-smoke source phrase must stay auditable.',
        timestamp: Date.parse('2026-05-16T12:00:00Z'),
        isDM: false,
      },
    ];

    const built = await buildRoomSummary(messages, 60 * 60 * 1000);

    expect(built.summary).toContain('Summarized 1 Matrix messages');
    expect(built.content).toContain('## Summary');
    expect(built.content).toContain('LLM summary intentionally omits the smoke phrase.');
    expect(built.content).toContain('## Source Messages');
    expect(built.content).toContain('shape-matrix-live-smoke source phrase must stay auditable.');
  });

  it('offers private account setup for unlinked Matrix DMs', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      linked: false,
      matrixUserId: '@alice:matrix.test',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
      sendDM: vi.fn(async () => '$dm'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('start', true));

    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('link existing'),
      expect.anything(),
    );
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('create <handle>'),
      expect.anything(),
    );
  });

  it('reports the linked private Router handle for linked Matrix users', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      linked: true,
      handle: 'alice_router',
      matrixBinding: { userId: '@alice:matrix.test', boundAt: 123 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('link', true));

    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('@alice_router'),
      expect.anything(),
    );
  });

  it('creates a private Matrix link code for existing Router accounts', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/api/matrix/link-status')) {
        return new Response(JSON.stringify({ linked: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'MATRIX-ABC123', expiresAt: Date.now() + 600_000 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
      sendDM: vi.fn(async () => '$dm'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('link', true));

    expect(fetchCalls.some(call => call.url === 'https://shape.test/api/matrix/link-code?key=shape-key')).toBe(true);
    expect(fetchCalls.find(call => call.url.includes('/api/matrix/link-code'))?.body.matrix_user_id).toBe('@alice:matrix.test');
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('MATRIX-ABC123'),
      expect.anything(),
    );
  });

  it('also creates a private Matrix link code for the explicit link existing command', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/api/matrix/link-status')) {
        return new Response(JSON.stringify({ linked: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'MATRIX-XYZ789', expiresAt: Date.now() + 600_000 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
      sendDM: vi.fn(async () => '$dm'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('link existing', true));

    expect(fetchCalls.some(call => call.url === 'https://shape.test/api/matrix/link-code?key=shape-key')).toBe(true);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('MATRIX-XYZ789'),
      expect.anything(),
    );
  });

  it('provisions a new private Router account only in Matrix DM', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';
    process.env.SHAPE_MATRIX_REQUIRE_SPACE_MEMBERSHIP_FOR_PROVISION = '0';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/api/matrix/link-status')) {
        return new Response(JSON.stringify({ linked: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        user: { handle: 'alice_router', matrixBinding: { userId: '@alice:matrix.test' } },
        secret_key: 'shape-secret-key',
        setup_url: 'https://shape.test/setup',
        mcp_url: 'https://shape.test/mcp/sse?key=shape-secret-key',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('create alice_router', true));

    expect(fetchCalls.find(call => call.url.includes('/api/matrix/provision'))?.body).toMatchObject({
      matrix_user_id: '@alice:matrix.test',
      handle: 'alice_router',
    });
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('shape-secret-key'),
      expect.anything(),
    );
  });

  it('does not send new Router credentials into an unencrypted Matrix DM', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ linked: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
      sendEncryptedDM: vi.fn(async () => '$encrypted-dm'),
    };
    const event = matrixMentionEvent('create alice_router', true);
    event.data.is_encrypted = false;

    await handleMention(matrix as any, null, event);

    expect(fetchCalls.some(call => call.url.includes('/api/matrix/provision'))).toBe(false);
    expect(matrix.sendEncryptedDM).toHaveBeenCalledWith(
      '@alice:matrix.test',
      expect.stringContaining('encrypted DM'),
      expect.anything(),
    );
    expect(matrix.sendMessage).not.toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Secret key:'),
      expect.anything(),
    );
  });

  it('does not post new Router credentials in public Matrix rooms', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      linked: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
      sendDM: vi.fn(async () => '$dm'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('create alice_router', false));

    expect(matrix.sendDM).toHaveBeenCalledWith(
      '@alice:matrix.test',
      expect.stringContaining('DM me `create <handle>`'),
      expect.anything(),
    );
    expect(matrix.sendMessage).not.toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Secret key:'),
      expect.anything(),
    );
  });

  it('files a private Router approval request when Matrix auto-provisioning is not allowed', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/api/matrix/link-status')) {
        return new Response(JSON.stringify({ linked: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        entry: {
          id: 'approval-request',
          summary: 'Matrix Router account approval needed',
          tags: ['matrix-provision-request', 'shape-rotator', 'matrix'],
          publishAt: null,
        },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
      isUserInConfiguredSpace: vi.fn(() => false),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('create alice_router', true));

    expect(fetchCalls.some(call => call.url.includes('/api/matrix/provision'))).toBe(false);
    const requestCall = fetchCalls.find(call => call.url.includes('/api/entries?key=shape-key'))!;
    expect(requestCall.body.tags).toEqual(['matrix-provision-request', 'shape-rotator', 'matrix']);
    expect(requestCall.body.content).toContain('Matrix user: @alice:matrix.test');
    expect(requestCall.body.content).toContain('Requested Router handle: @alice_router');
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('organizer approval request'),
      expect.anything(),
    );
  });

  it('handles Matrix save commands by writing private Router entries with provenance', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        entry: { id: 'entry-save', summary: 'saved', tags: ['matrix-note', 'shape-rotator', 'matrix'], publishAt: null },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const sent: any[] = [];
    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async (...args: any[]) => {
        sent.push(args);
        return '$reply';
      }),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('save we decided to use private Router'));

    const writeCall = fetchCalls.find(call => call.url.includes('/api/entries?key=shape-key'))!;
    expect(writeCall.url).toBe('https://shape.test/api/entries?key=shape-key');
    expect(writeCall.body.tags).toEqual(['matrix-note', 'shape-rotator', 'matrix']);
    expect(writeCall.body.content).toContain('Source: Matrix room');
    expect(writeCall.body.content).toContain('Room ID: !room:matrix.test');
    expect(writeCall.body.content).toContain('Organizer: @alice');
    expect(sent[0][1]).toContain('Saved to private Shape Router');
    expect(sent[0][1]).toContain('https://shape.test/entry?id=entry-save');
  });

  it('handles Matrix DM save commands without touching the public Router', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        entry: { id: 'entry-dm', summary: 'saved', tags: ['matrix-note', 'shape-rotator', 'matrix'], publishAt: null },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('save DM-only note for private Router', true));

    const writeCall = fetchCalls.find(call => call.url.includes('/api/entries?key=shape-key'))!;
    expect(writeCall.url).toBe('https://shape.test/api/entries?key=shape-key');
    expect(writeCall.body.content).toContain('Source: Matrix DM');
    expect(writeCall.body.content).toContain('DM-only note for private Router');
    expect(writeCall.url).not.toContain('router.teleport.computer');
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Saved to private Shape Router'),
      expect.anything(),
    );
  });

  it('summarizes Matrix DMs with DM history enabled', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entry: { id: 'entry-dm-summary', summary: 'summary', tags: ['matrix-summary', 'shape-rotator', 'matrix'], publishAt: null },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(async () => [
        {
          roomId: '!room:matrix.test',
          roomName: 'Router DM',
          senderId: '@alice:matrix.test',
          senderHandle: 'alice',
          text: 'This private DM context should stay in Shape Router.',
          timestamp: Date.parse('2026-05-16T12:00:00Z'),
          isDM: true,
        },
      ]),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('summarize this room 30m', true));

    expect(matrix.queryRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomIds: ['!room:matrix.test'],
      includeDMs: true,
      viewerUserId: '@alice:matrix.test',
    }));
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Saved Matrix room context to private Shape Router'),
      expect.anything(),
    );
  });

  it('answers Matrix searches from private Router HTTP fallback when MCP is unavailable', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entries: [
        { id: 'entry-search', summary: 'Private Router migration notes', content: 'Contains the migration fallback detail.', tags: ['shape-rotator', 'matrix'] },
        { id: 'entry-other', summary: 'Unrelated note', tags: ['misc'] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('search fallback'));

    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Private Shape Router search results'),
      expect.objectContaining({ replyTo: '$mention' }),
    );
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('[entry-search] Private Router migration notes'),
      expect.anything(),
    );
  });

  it('bypasses the private Hermes agent for explicit Matrix search commands', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';
    process.env.SHAPE_MATRIX_AGENT_URL = 'http://shape-agent.test/matrix/event';

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://shape.test/api/entries')) {
        return new Response(JSON.stringify({
          entries: [
            {
              id: 'entry-command-search',
              summary: 'Command search smoke note',
              content: 'Contains explicit-search-sentinel detail.',
              tags: ['shape-rotator', 'matrix'],
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('search explicit-search-sentinel'));

    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://shape-agent.test/matrix/event',
      expect.anything(),
    );
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Private Shape Router search results'),
      expect.objectContaining({ replyTo: '$mention' }),
    );
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('[entry-command-search] Command search smoke note'),
      expect.anything(),
    );
  });

  it('routes ordinary Matrix questions to the private Hermes agent when configured', async () => {
    process.env.SHAPE_MATRIX_AGENT_URL = 'http://shape-agent.test/matrix/event';
    process.env.SHAPE_MATRIX_AGENT_SECRET = 'agent-shared-secret';

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://shape-agent.test/matrix/event');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer agent-shared-secret');
      const body = JSON.parse(String(init?.body));
      expect(body.event.type).toBe('platform_mention');
      expect(body.event.data.text).toBe('do you hear me');
      expect(body.event.data.original_text).toBe('do you hear me');
      return new Response(JSON.stringify({ reply: 'Yes. I can hear you and I will use the private notebook when needed.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('do you hear me', true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      'Yes. I can hear you and I will use the private notebook when needed.',
      expect.objectContaining({ replyTo: '$mention' }),
    );
  });

  it('attaches live Matrix context for Matrix-server recap questions sent to Hermes', async () => {
    process.env.SHAPE_MATRIX_AGENT_URL = 'http://shape-agent.test/matrix/event';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://shape-agent.test/matrix/event');
      const body = JSON.parse(String(init?.body));
      expect(body.event.data.text).toBe('what has been happening in the matrix server lately?');
      expect(body.event.data.matrix_context).toEqual(expect.objectContaining({
        source: 'live Matrix search by shape-matrix-bridge',
        scope: 'joined non-DM Matrix rooms',
        search_performed: true,
        message_count: 2,
      }));
      expect(body.event.data.matrix_context.messages).toEqual([
        expect.objectContaining({ text: 'Earlier room context', sender_handle: 'bob' }),
        expect.objectContaining({ text: 'Later room context', sender_handle: 'carol' }),
      ]);
      return new Response(JSON.stringify({ reply: 'I checked Matrix directly: earlier and later context.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(async () => [
        {
          roomId: '!general:matrix.test',
          roomName: 'General',
          senderId: '@carol:matrix.test',
          senderHandle: 'carol',
          text: 'Later room context',
          timestamp: 2000,
          isDM: false,
        },
        {
          roomId: '!general:matrix.test',
          roomName: 'General',
          senderId: '@bob:matrix.test',
          senderHandle: 'bob',
          text: 'Earlier room context',
          timestamp: 1000,
          isDM: false,
        },
      ]),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('what has been happening in the matrix server lately?'));

    expect(matrix.queryRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomIds: undefined,
      includeDMs: false,
      viewerUserId: undefined,
      spaceOnly: false,
      botScope: true,
    }));
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      'I checked Matrix directly: earlier and later context.',
      expect.objectContaining({ replyTo: '$mention' }),
    );
  });

  it('does not include DMs when Hermes asks for Matrix-server context from a DM', async () => {
    process.env.SHAPE_MATRIX_AGENT_URL = 'http://shape-agent.test/matrix/event';

    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.event.data.matrix_context).toEqual(expect.objectContaining({
        scope: 'joined non-DM Matrix rooms',
        message_count: 0,
      }));
      return new Response(JSON.stringify({ reply: 'No broad DM history included.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('what happened on the matrix server lately?', true));

    expect(matrix.queryRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomIds: undefined,
      includeDMs: false,
      viewerUserId: undefined,
      spaceOnly: false,
      botScope: true,
    }));
  });

  it('lets the private Hermes agent handle notebook-summary requests', async () => {
    process.env.SHAPE_MATRIX_AGENT_URL = 'http://shape-agent.test/matrix/event';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(input)).toBe('http://shape-agent.test/matrix/event');
      expect(body.event.data.text).toBe('summarize the notebook so far');
      return new Response(JSON.stringify({ reply: 'Notebook summary from Hermes.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('summarize the notebook so far', true));

    expect(matrix.queryRecentMessages).not.toHaveBeenCalled();
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      'Notebook summary from Hermes.',
      expect.objectContaining({ replyTo: '$mention' }),
    );
  });

  it('falls back to private Router author search when the Hermes agent keyword search reports no results', async () => {
    process.env.SHAPE_MATRIX_AGENT_URL = 'http://shape-agent.test/matrix/event';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://shape-agent.test/matrix/event') {
        const body = JSON.parse(String(init?.body));
        expect(body.event.data.text).toBe('what about all these posts from whimsy?');
        return new Response(JSON.stringify({ reply: 'I searched the Router notebook for "whimsy" and did not find any entries.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(),
      sendMessage: vi.fn(async () => '$reply'),
    };
    const mcpClient = {
      callTool: vi.fn(async (call: any) => {
        expect(call).toEqual({
          name: 'router_search',
          arguments: { handle: 'whimsy', limit: 5 },
        });
        return {
          content: [{
            type: 'text',
            text: 'Found 1 result:\n\n[mpgcq5fa-oy670y] @whimsy · 5/22/2026\nFucory routing note.',
          }],
        };
      }),
    };

    await handleMention(matrix as any, mcpClient as any, matrixMentionEvent('what about all these posts from whimsy?'));

    expect(matrix.queryRecentMessages).not.toHaveBeenCalled();
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('private Router author search for @whimsy found'),
      expect.objectContaining({ replyTo: '$mention' }),
    );
    const reply = (matrix.sendMessage as any).mock.calls[0][1];
    expect(reply).toContain('Fucory routing note');
  });

  it('falls back to private Router HTTP search when an MCP session expires', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entries: [
        { id: 'entry-expired', summary: 'Expired MCP fallback note', content: 'Contains stale session fallback detail.', tags: ['shape-rotator', 'matrix'] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };
    const mcpClient = {
      callTool: vi.fn(async () => {
        throw new Error('Streamable HTTP error: Session not found — please re-initialize.');
      }),
    };

    await handleMention(matrix as any, mcpClient as any, matrixMentionEvent('search fallback'));

    expect(mcpClient.callTool).toHaveBeenCalledWith({
      name: 'router_search',
      arguments: { query: 'fallback', limit: 5 },
    });
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('[entry-expired] Expired MCP fallback note'),
      expect.anything(),
    );
  });

  it('handles Matrix room summaries by reading Matrix context and writing private Router entries', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        entry: { id: 'entry-summary', summary: 'summary', tags: ['matrix-summary', 'shape-rotator', 'matrix'], publishAt: null },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(async () => [
        {
          roomId: '!room:matrix.test',
          roomName: 'Shape General',
          senderId: '@alice:matrix.test',
          senderHandle: 'alice',
          text: 'Let us keep this private and broadcast only a digest.',
          timestamp: Date.parse('2026-05-16T12:00:00Z'),
          isDM: false,
        },
      ]),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('summarize this room 1h'));

    expect(matrix.queryRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomIds: ['!room:matrix.test'],
      includeDMs: false,
      viewerUserId: '@alice:matrix.test',
    }));
    const writeCall = fetchCalls.find(call => call.url.includes('/api/entries?key=shape-key'))!;
    expect(writeCall.body.tags).toEqual(['matrix-summary', 'shape-rotator', 'matrix']);
    expect(writeCall.body.content).toContain('Source: Matrix room "Shape General"');
    expect(writeCall.body.content).toContain('broadcast only a digest');
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Saved Matrix room context to private Shape Router'),
      expect.anything(),
    );
  });
});

function matrixMentionEvent(text: string, isDM = false): RouterEvent {
  return {
    id: 1,
    type: 'platform_mention',
    timestamp: Date.now(),
    data: {
      platform: 'matrix',
      room_id: '!room:matrix.test',
      message_id: '$mention',
      sender_id: '@alice:matrix.test',
      sender_handle: 'alice',
      text,
      is_dm: isDM,
      is_encrypted: isDM,
    },
  };
}

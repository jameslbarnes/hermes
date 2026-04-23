/**
 * Integration tests for Hermes MCP tools.
 *
 * Spawns the server as a child process on a random port,
 * connects via SSE as an MCP client, and exercises the agent tools.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn, type ChildProcess } from 'child_process';
import { generateSecretKey } from './identity.js';

const TEST_PORT = 9876 + Math.floor(Math.random() * 1000);
const MODERATOR_KEY = generateSecretKey();
const REGULAR_KEY = generateSecretKey();
// Unique per run to avoid Firestore collisions from previous runs
const MODERATOR_HANDLE = `mod${Date.now().toString(36).slice(-6)}`;

let serverProcess: ChildProcess;
let modClient: Client;
let modTransport: SSEClientTransport;
let regularClient: Client;
let regularTransport: SSEClientTransport;

async function callTool(client: Client, name: string, args: Record<string, any> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const textBlock = (result.content as any[])?.find((b: any) => b.type === 'text');
  return textBlock?.text || '';
}

async function waitForServer(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/entries`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function connectClient(port: number, secretKey: string): Promise<{ client: Client; transport: SSEClientTransport }> {
  const url = new URL(`http://localhost:${port}/mcp/sse?key=${secretKey}`);
  const transport = new SSEClientTransport(url);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('MCP Tool Integration Tests', () => {
  beforeAll(async () => {
    serverProcess = spawn('npx', ['tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        STAGING_DELAY_MS: '3600000',
        MODERATOR_HANDLES: MODERATOR_HANDLE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    serverProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line && !line.includes('ExperimentalWarning') && !line.includes('Unauthorized')) {
        console.error(`[server:err] ${line}`);
      }
    });

    await waitForServer(TEST_PORT);

    // Register moderator identity
    const regRes = await fetch(`http://localhost:${TEST_PORT}/api/identity/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_key: MODERATOR_KEY, handle: MODERATOR_HANDLE }),
    });
    if (!regRes.ok) {
      throw new Error(`Register failed: ${await regRes.text()}`);
    }

    // Connect clients
    const mod = await connectClient(TEST_PORT, MODERATOR_KEY);
    modClient = mod.client;
    modTransport = mod.transport;

    const reg = await connectClient(TEST_PORT, REGULAR_KEY);
    regularClient = reg.client;
    regularTransport = reg.transport;
  }, 30000);

  afterAll(async () => {
    try { await modTransport?.close(); } catch {}
    try { await regularTransport?.close(); } catch {}
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        serverProcess.on('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
  });

  // ── Tool Discovery ──────────────────────────────────────

  describe('Tool discovery', () => {
    it('moderator sees agent tools', async () => {
      const { tools } = await modClient.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('hermes_poll_events');
      expect(names).toContain('hermes_review_staged');
      expect(names).toContain('hermes_hold_entry');
      expect(names).toContain('hermes_release_entry');
    });

    it('regular user does NOT see agent tools', async () => {
      const { tools } = await regularClient.listTools();
      const names = tools.map(t => t.name);
      expect(names).not.toContain('hermes_poll_events');
      expect(names).not.toContain('hermes_hold_entry');
    });

    it('both see standard tools', async () => {
      for (const client of [modClient, regularClient]) {
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name);
        expect(names).toContain('hermes_write_entry');
        expect(names).toContain('hermes_search');
      }
    });
  });

  // ── Event Queue ──────────────────────────────────────────

  describe('hermes_poll_events', () => {
    it('returns no events initially', async () => {
      const result = await modClient.callTool({ name: 'hermes_poll_events', arguments: { cursor: 0 } });
      const textBlock = (result.content as any[])?.find((b: any) => b.type === 'text');
      const text = textBlock?.text || '';
      expect(text).toContain('No new events');
      expect(result.structuredContent).toMatchObject({
        events: [],
        latest_cursor: 0,
        next_cursor: 0,
      });
    });

    it('sees entry_staged after write', async () => {
      await callTool(regularClient, 'hermes_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Event polling test entry',
      });
      const text = await callTool(modClient, 'hermes_poll_events', { cursor: 0 });
      expect(text).toContain('entry_staged');
      // Content should NOT be in events (privacy)
      expect(text).not.toContain('Event polling test');
    });

    it('cursor-based pagination works', async () => {
      const first = await callTool(modClient, 'hermes_poll_events', { cursor: 0 });
      const cursor = parseInt(first.match(/cursor (\d+)/)![1]);

      await callTool(regularClient, 'hermes_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Cursor pagination test',
      });

      // Should see a new event with higher cursor
      const second = await callTool(modClient, 'hermes_poll_events', { cursor });
      expect(second).toContain('entry_staged');
    });
  });

  // ── Content Moderation ──────────────────────────────────

  describe('hermes_review_staged', () => {
    it('lists pending entries', async () => {
      const text = await callTool(modClient, 'hermes_review_staged', {});
      expect(text).toContain('pending entries');
      expect(text).toContain('publishes in');
    });
  });

  describe('hermes_hold_entry', () => {
    let heldEntryId: string;

    it('holds a staged entry', async () => {
      const wr = await callTool(regularClient, 'hermes_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'I hate my cofounder, they never shut up',
      });
      heldEntryId = wr.match(/Entry ID: (\S+)/)![1];

      const hold = await callTool(modClient, 'hermes_hold_entry', {
        entry_id: heldEntryId,
        reason: 'Interpersonal complaint.',
      });
      expect(hold).toContain('held indefinitely');
    });

    it('shows HELD in review', async () => {
      const text = await callTool(modClient, 'hermes_review_staged', {});
      expect(text).toContain('HELD (indefinite)');
      expect(text).toContain(heldEntryId);
    });

    it('rejects non-existent entry', async () => {
      const text = await callTool(modClient, 'hermes_hold_entry', { entry_id: 'fake-id' });
      expect(text).toContain('not in the staging buffer');
    });

    it('requires entry_id', async () => {
      const text = await callTool(modClient, 'hermes_hold_entry', {});
      expect(text).toContain('Entry ID is required');
    });
  });

  describe('hermes_release_entry', () => {
    it('releases a held entry', async () => {
      const wr = await callTool(regularClient, 'hermes_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Safe entry for release test',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      await callTool(modClient, 'hermes_hold_entry', { entry_id: entryId, reason: 'test' });
      const release = await callTool(modClient, 'hermes_release_entry', { entry_id: entryId });
      expect(release).toContain('released and published');

      const review = await callTool(modClient, 'hermes_review_staged', {});
      expect(review).not.toContain(entryId);
    });

    it('rejects non-existent entry', async () => {
      const text = await callTool(modClient, 'hermes_release_entry', { entry_id: 'fake-id' });
      expect(text).toContain('not in the staging buffer');
    });
  });

  // ── Full Lifecycle ──────────────────────────────────────

  describe('Full moderation lifecycle', () => {
    it('write → stage event → review → hold → release', async () => {
      // 1. Write
      const wr = await callTool(regularClient, 'hermes_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'TEE attestation observation for lifecycle test',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      // 2. Poll → entry_staged
      const events = await callTool(modClient, 'hermes_poll_events', { cursor: 0, limit: 100 });
      expect(events).toContain('entry_staged');
      expect(events).not.toContain('TEE attestation'); // content not leaked in events

      // 3. Review
      const staged = await callTool(modClient, 'hermes_review_staged', {});
      expect(staged).toContain(entryId);

      // 4. Hold
      await callTool(modClient, 'hermes_hold_entry', { entry_id: entryId, reason: 'review' });
      const held = await callTool(modClient, 'hermes_review_staged', {});
      expect(held).toContain('HELD');

      // 5. Release
      const release = await callTool(modClient, 'hermes_release_entry', { entry_id: entryId });
      expect(release).toContain('released and published');

      // 6. Gone from staging
      const final = await callTool(modClient, 'hermes_review_staged', {});
      expect(final).not.toContain(entryId);
    });
  });
});

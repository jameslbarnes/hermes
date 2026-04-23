import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[worker] ${message}`);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function formatExecFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  return [message, stderr, stdout].filter(Boolean).join('\n').slice(0, 4000);
}

function parseCursor(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildMcpUrl(baseUrl, secretKey) {
  const url = new URL(baseUrl);
  url.searchParams.set('key', secretKey);
  return url;
}

async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { cursor: 0 };
  }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function firstWord(text) {
  const parts = String(text || '').trim().toLowerCase().split(/\s+/);
  return parts[0] || '';
}

async function connectClient(mcpUrl) {
  const client = new Client({ name: 'router-event-worker', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(transport);
  return { client, transport };
}

async function runAgentChat(event) {
  const data = event?.data || {};
  const text = data.text || '';
  const command = firstWord(text);

  if (command === 'link' || command === '/link' || command === 'help' || command === '/help') {
    log(`Skipping ${command} event ${event.id} — handled server-side`);
    return;
  }

  const prompt = `You are Router, the Hermes platform-facing agent.

You received a notebook event from the real-time event queue.

Event:
${JSON.stringify(event, null, 2)}

This event is directed at Router. If it is a human platform_mention, you must send exactly one reply in the originating platform room.
This applies to channel mentions as well as direct DMs.
Use Hermes notebook tools as needed. Your reply must be sent by calling hermes_platform_send with:
- platform = event.data.platform
- room_id = event.data.room_id
- reply_to = event.data.message_id

Hard rules:
- Do not ask the user to manually invoke Hermes tools.
- link/help commands are already handled upstream; do nothing for those.
- Keep replies concise and natural.
- Do not silently choose not to answer a human platform_mention.
- If you truly cannot answer, send a brief apology or clarification via hermes_platform_send.

After acting, return a one-line summary of what you did.`;

  const env = {
    ...process.env,
    HERMES_HOME: process.env.HERMES_HOME || '/data/hermes-agent',
  };

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      'hermes',
      ['chat', '-q', prompt, '--provider', 'anthropic', '-Q', '--yolo'],
      {
        env,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch (error) {
    throw new Error(`hermes chat failed for event ${event.id}: ${formatExecFailure(error)}`);
  }

  const summary = String(stdout || stderr || '').trim().split('\n').filter(Boolean).at(-1);
  log(`Event ${event.id} handled${summary ? `: ${summary.slice(0, 300)}` : ''}`);
}

async function main() {
  const hermesHome = process.env.HERMES_HOME || '/data/hermes-agent';
  const secretKey = (process.env.HERMES_SECRET_KEY || '').trim();
  const mcpUrl = process.env.HERMES_MCP_URL || 'http://hermes:3000/mcp/http';
  const pollIntervalMs = Number.parseInt(process.env.HERMES_EVENT_POLL_INTERVAL_MS || '2000', 10);
  const pollLimit = Number.parseInt(process.env.HERMES_EVENT_LIMIT || '20', 10);
  const statePath = join(hermesHome, 'router-event-worker-state.json');

  if (!secretKey) {
    throw new Error('HERMES_SECRET_KEY is required');
  }

  let client;
  let transport;
  async function reconnect() {
    if (transport) {
      try {
        await transport.close();
      } catch {}
    }
    const connection = await connectClient(buildMcpUrl(mcpUrl, secretKey));
    client = connection.client;
    transport = connection.transport;

    const tools = await client.listTools();
    const toolNames = new Set((tools.tools || []).map((tool) => tool.name));
    if (!toolNames.has('hermes_poll_events')) {
      throw new Error('hermes_poll_events not available to this identity');
    }

    log(`Connected to MCP with ${tools.tools.length} tools`);
  }

  await reconnect();

  let state = await loadState(statePath);
  let cursor = Number.parseInt(String(state.cursor || 0), 10) || 0;
  log(`Starting event loop at cursor ${cursor}`);

  while (true) {
    let events;
    try {
      const result = await client.callTool({
        name: 'hermes_poll_events',
        arguments: { cursor, limit: pollLimit },
      });

      const structured = result.structuredContent || {};
      events = Array.isArray(structured.events) ? structured.events : [];
      const nextCursor = parseCursor(structured.next_cursor ?? structured.latest_cursor ?? cursor, cursor);

      if (events.length === 0) {
        if (nextCursor < cursor) {
          log(`Cursor reset detected (${cursor} -> ${nextCursor}); server likely restarted`);
        }
        cursor = nextCursor;
        state.cursor = cursor;
        await saveState(statePath, state);
        await sleep(pollIntervalMs);
        continue;
      }
    } catch (error) {
      log(`Poll error: ${formatError(error)}`);
      try {
        await reconnect();
      } catch (reconnectError) {
        log(`Reconnect failed: ${formatError(reconnectError)}`);
      }
      await sleep(Math.max(pollIntervalMs, 2000));
      continue;
    }

    for (const event of events) {
      const eventId = parseCursor(event.id, 0);
      const eventType = event.type;
      const data = event.data || {};

      if (eventType !== 'platform_mention') {
        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);
        continue;
      }

      if (data.platform !== 'matrix') {
        log(`Skipping event ${eventId} on unsupported platform ${data.platform}`);
        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);
        continue;
      }

      log(
        `Processing Matrix platform_mention ${eventId} in ${data.room_id} from ${data.sender_id || 'unknown'} (dm=${data.is_dm ? 'yes' : 'no'})`,
      );

      try {
        await runAgentChat(event);
      } catch (error) {
        log(`Event ${eventId} handler error: ${formatError(error)}`);
        await sleep(Math.max(pollIntervalMs, 2000));
        break;
      }

      cursor = Math.max(cursor, eventId);
      state.cursor = cursor;
      await saveState(statePath, state);
    }
  }
}

main().catch((error) => {
  log(`Fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});

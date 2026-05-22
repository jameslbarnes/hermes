import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
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

function parseEnvInt(names, fallback) {
  for (const name of names) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function matrixHandlingEnabled() {
  const raw = process.env.ROUTER_AGENT_HANDLES_MATRIX || '';
  return ['1', 'true', 'yes', 'remote'].includes(raw.trim().toLowerCase());
}

function httpAgentModeEnabled() {
  const raw = process.env.ROUTER_AGENT_HTTP_MODE || process.env.SHAPE_MATRIX_AGENT_HTTP_MODE || '';
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function buildMcpUrl(baseUrl, secretKey) {
  const url = new URL(baseUrl);
  url.searchParams.set('key', secretKey);
  return url;
}

async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ...JSON.parse(raw), initialized: true };
  } catch {
    return { cursor: 0, initialized: false };
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

function eventTimestamp(event) {
  const direct = Number(event?.timestamp);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const dataTs = Number(event?.data?.timestamp);
  if (Number.isFinite(dataTs) && dataTs > 0) return dataTs;

  return 0;
}

function matrixRoomKey(event) {
  const data = event?.data || {};
  if (event?.type !== 'platform_mention') return null;
  if (data.platform !== 'matrix') return null;
  return typeof data.room_id === 'string' && data.room_id ? data.room_id : null;
}

function matrixMessageId(event) {
  const data = event?.data || {};
  if (event?.type !== 'platform_mention') return null;
  if (data.platform !== 'matrix') return null;
  return typeof data.message_id === 'string' && data.message_id ? data.message_id : null;
}

function onboardingKey(event) {
  const data = event?.data || {};
  if (event?.type !== 'platform_onboarding') return null;
  if (!data.platform || !data.platform_user_id) return null;
  return `${data.platform}:${data.platform_user_id}:${data.reason || 'onboarding'}`;
}

function latestMatrixMentionIdsByRoom(events) {
  const latest = new Map();
  for (const event of events) {
    const roomKey = matrixRoomKey(event);
    if (!roomKey) continue;
    const eventId = parseCursor(event.id, 0);
    latest.set(roomKey, Math.max(latest.get(roomKey) || 0, eventId));
  }
  return latest;
}

function handledMatrixMessageIds(state) {
  if (!Array.isArray(state.handled_matrix_message_ids)) {
    state.handled_matrix_message_ids = [];
  }
  return state.handled_matrix_message_ids;
}

function hasHandledMatrixMessage(state, messageId) {
  return !!messageId && handledMatrixMessageIds(state).includes(messageId);
}

function rememberHandledMatrixMessage(state, messageId, limit) {
  if (!messageId) return;

  const ids = handledMatrixMessageIds(state);
  const existing = ids.indexOf(messageId);
  if (existing >= 0) ids.splice(existing, 1);
  ids.push(messageId);

  const max = Number.isFinite(limit) && limit > 0 ? limit : 2000;
  if (ids.length > max) {
    ids.splice(0, ids.length - max);
  }
}

function handledOnboardingKeys(state) {
  if (!Array.isArray(state.handled_onboarding_keys)) {
    state.handled_onboarding_keys = [];
  }
  return state.handled_onboarding_keys;
}

function hasHandledOnboarding(state, key) {
  return !!key && handledOnboardingKeys(state).includes(key);
}

function rememberHandledOnboarding(state, key, limit) {
  if (!key) return;

  const keys = handledOnboardingKeys(state);
  const existing = keys.indexOf(key);
  if (existing >= 0) keys.splice(existing, 1);
  keys.push(key);

  const max = Number.isFinite(limit) && limit > 0 ? limit : 2000;
  if (keys.length > max) {
    keys.splice(0, keys.length - max);
  }
}

async function connectClient(mcpUrl) {
  const client = new Client({ name: 'router-event-worker', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(transport);
  return { client, transport };
}

async function runHermesPrompt(event, prompt, label, options = {}) {
  const env = {
    ...process.env,
    ROUTER_HOME: process.env.ROUTER_HOME || process.env.HERMES_HOME || '/data/router-agent',
  };
  env.HERMES_HOME = env.ROUTER_HOME;
  const timeoutMs = options.timeoutMs || parseEnvInt(['ROUTER_HERMES_CHAT_TIMEOUT_MS', 'HERMES_CHAT_TIMEOUT_MS'], 180_000);

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      'hermes',
      ['chat', '-q', prompt, '--provider', 'anthropic', '-Q', '--yolo'],
      {
        env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch (error) {
    throw new Error(`hermes chat failed for ${label} ${event.id} after ${timeoutMs}ms: ${formatExecFailure(error)}`);
  }

  const summary = String(stdout || stderr || '').trim().split('\n').filter(Boolean).at(-1);
  log(`${label} ${event.id} handled${summary ? `: ${summary.slice(0, 300)}` : ''}`);
  return String(stdout || '').trim();
}

async function runOnboardingChat(event) {
  const data = event?.data || {};
  const prompt = `You are Router, the Matrix-facing onboarding agent.

A Matrix user has just joined the Shape Rotator Matrix space and should receive one private onboarding DM from the Router bot.

Event:
${JSON.stringify(event, null, 2)}

Send exactly one private DM by calling router_platform_send_dm with:
- platform = "matrix"
- platform_user_id = event.data.platform_user_id
- text = your onboarding message

The DM must:
- Welcome them briefly.
- Explain that Router is a shared notebook for Claude conversations.
- Say Router can create their identity inside the attested Router environment if they consent.
- Explain the privacy model in plain language: Router runs in a TEE, stores only a hash of the Router secret key, and exposes attestation so they can verify the running code.
- Include the attestation endpoint: ${process.env.ROUTER_PUBLIC_URL || process.env.BASE_URL || 'https://router.teleport.computer'}/api/attestation
- Mention that the generated secret key will be sent in this Matrix DM, they should save it in a password manager, and they may delete the DM after saving it.
- Tell them the exact next step: reply with \`onboard their_handle\` where the handle is 3-15 lowercase letters, numbers, or underscores, starting with a letter.
- Offer the self-custody fallback: open ${process.env.ROUTER_PUBLIC_URL || process.env.BASE_URL || 'https://router.teleport.computer'}/join if they prefer to generate the key themselves.

Do not create an identity yet. Do not ask them to use Router tools manually. After sending the DM, return a one-line summary.`;

  await runHermesPrompt(event, prompt, 'Onboarding event');
}

async function runAgentChat(event) {
  const data = event?.data || {};
  const text = data.text || '';
  const command = firstWord(text);

  if (command === 'link' || command === '/link' || command === 'help' || command === '/help') {
    log(`Skipping ${command} event ${event.id} — handled server-side`);
    return;
  }

  const prompt = `You are Router, the platform-facing agent.

You received a notebook event from the real-time event queue.

Event:
${JSON.stringify(event, null, 2)}

This event is directed at Router. If it is a human platform_mention, you must send exactly one reply in the originating platform room.
This applies to channel mentions as well as direct DMs.
Use Router notebook tools as needed. Your reply must be sent by calling router_platform_send with:
- platform = event.data.platform
- room_id = event.data.room_id
- reply_to = event.data.message_id

Matrix context:
- Use router_search_matrix liberally before answering Matrix mentions when prior room context could matter: "this room", "recently here", "above", "that", "what happened", "what did I miss", summaries, replies to earlier points, ambiguous references, or anything that looks context-dependent.
- For current-room context, call router_search_matrix with room_id = event.data.room_id, a since window like "2h", "24h", or "7d", and limit 20-40. No query is needed when a broad read of the room is useful.
- For cross-room Matrix questions, call router_search_matrix with a query and/or since window. Router can search non-DM Matrix rooms it has joined.
- Do not search DMs broadly. Only search a DM when event.data.is_dm is true and you pass event.data.room_id for that current DM.

Onboarding command:
- If this is a Matrix DM and the text begins with "onboard " followed by a proposed handle, provision the identity by calling router_onboard_identity with platform="matrix", platform_user_id=event.data.sender_id, desired_handle=<the proposed handle>, display_name=event.data.sender_handle if useful, source="matrix_dm_onboard_command".
- If provisioning succeeds, reply in the originating room with router_platform_send. Include the returned handle, secret_key, mcp_url, and attestation_url verbatim. Tell the user to save the key in a password manager, that Router stores only a hash, and that they may delete the Matrix message after saving it.
- If the handle is invalid or taken, reply with the exact handle rule and ask for another \`onboard handle\`.

Hard rules:
- Do not ask the user to manually invoke Router tools.
- link/help commands are already handled upstream; do nothing for those.
- Keep replies concise and natural.
- Do not silently choose not to answer a human platform_mention.
- If you truly cannot answer, send a brief apology or clarification via router_platform_send.

After acting, return a one-line summary of what you did.`;

  await runHermesPrompt(event, prompt, 'Event');
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function configuredHttpSecret() {
  return (
    process.env.ROUTER_AGENT_HTTP_SECRET ||
    process.env.SHAPE_MATRIX_AGENT_SECRET ||
    process.env.SHAPE_MATRIX_AGENT_SHARED_SECRET ||
    ''
  ).trim();
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`Request body too large; max ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function cleanHermesReply(output) {
  const text = String(output || '').trim();
  if (!text) return '';

  const fenced = text.match(/```(?:text|markdown)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  return candidate
    .replace(/^final reply:\s*/i, '')
    .replace(/^reply:\s*/i, '')
    .trim();
}

async function runMatrixBridgeReply(event) {
  const data = event?.data || {};
  const text = String(data.text || '').trim();
  const prompt = `You are Shape Router, the Matrix-facing Hermes agent for the private Shape Rotator Router notebook.

You received a Matrix message from the private Matrix bridge. The bridge owns Matrix transport and will send your final answer back to the room. You own the notebook reasoning.

Event:
${JSON.stringify(event, null, 2)}

Current time:
${new Date().toISOString()}

Behavior:
- Answer ordinary greetings and questions naturally.
- For questions about the private Shape Router notebook, use the Router MCP tools available to you, especially router_search.
- If the user explicitly asks to search, call router_search instead of relying on memory.
- Interpret "today", "yesterday", and other relative dates against the Current time above.
- The bridge owns Matrix search. If event.data.matrix_context is present, it is a live Matrix history search performed by the bridge immediately before this call. Use it as the source of truth for Matrix room/thread/server context.
- Use event.data.matrix_context liberally for Matrix room/thread context: "this room", "here", "above", "that", "the thread", "what happened", "what did I miss", recaps, ambiguous references, and Matrix-server activity questions.
- If event.data.matrix_context.search_performed is true, do not say you lack Matrix search access. Say plainly whether you used Matrix context or only notebook tools if the user asks.
- If the user mentions an author like "@whimsy" or says "from whimsy", call router_search with handle="whimsy" instead of only searching query="whimsy".
- If the user provides Router entry IDs or entry URLs, call router_get_entry for those IDs.
- Do not use Matrix context as a fallback for private Router notebook entries that should be readable from private Router; use router_search/router_get_entry for notebook facts and event.data.matrix_context for Matrix conversation context.
- If router_search has no useful hits, say that plainly and offer a better query.
- Keep replies concise enough for Matrix.

Hard rules:
- Do not call router_platform_send or any platform-send tool in this mode; the bridge will deliver your final text.
- Do not ask the user to invoke Router tools manually.
- Do not expose secret keys, bearer tokens, or internal environment values.
- Return only the exact Matrix reply text. No JSON envelope. No tool log. No code fence.

User message:
${text}`;

  const output = await runHermesPrompt(event, prompt, 'Shape Matrix HTTP event', {
    timeoutMs: parseEnvInt(['SHAPE_MATRIX_AGENT_TIMEOUT_MS', 'ROUTER_HERMES_CHAT_TIMEOUT_MS', 'HERMES_CHAT_TIMEOUT_MS'], 180_000),
  });
  return cleanHermesReply(output);
}

async function startHttpAgentServer() {
  const port = parseEnvInt(['ROUTER_AGENT_HTTP_PORT', 'SHAPE_MATRIX_AGENT_PORT'], 8091);
  const host = process.env.ROUTER_AGENT_HTTP_HOST || '0.0.0.0';
  const secret = configuredHttpSecret();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', mode: 'http-agent' });
        return;
      }

      if (req.method !== 'POST' || url.pathname !== '/matrix/event') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      if (secret && bearerToken(req) !== secret) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const body = await readJsonBody(req);
      const event = body.event;
      if (!event || event.type !== 'platform_mention' || event.data?.platform !== 'matrix') {
        sendJson(res, 400, { error: 'expected Matrix platform_mention event' });
        return;
      }

      const reply = await runMatrixBridgeReply(event);
      sendJson(res, 200, { reply: reply || "I couldn't produce a reply." });
    } catch (error) {
      log(`HTTP Matrix event error: ${formatError(error)}`);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      log(`HTTP Matrix agent listening on ${host}:${port}`);
      resolve();
    });
  });

  await new Promise(() => {});
}

async function main() {
  const routerHome = process.env.ROUTER_HOME || process.env.HERMES_HOME || '/data/router-agent';
  const secretKey = (
    process.env.ROUTER_SECRET_KEY ||
    process.env.HERMES_SECRET_KEY ||
    process.env.HERMES_AGENT_SECRET_KEY ||
    process.env.SHAPE_ROUTER_SECRET_KEY ||
    ''
  ).trim();
  const mcpUrl = process.env.ROUTER_MCP_URL || process.env.HERMES_MCP_URL || 'http://router:3000/mcp/http';
  const pollIntervalMs = Number.parseInt(process.env.ROUTER_EVENT_POLL_INTERVAL_MS || '2000', 10);
  const pollLimit = Number.parseInt(process.env.ROUTER_EVENT_LIMIT || '20', 10);
  const maxEventAgeMs = Number.parseInt(process.env.ROUTER_EVENT_MAX_AGE_MS || '300000', 10);
  const handledMatrixMessageLimit = Number.parseInt(process.env.ROUTER_HANDLED_MATRIX_MESSAGE_IDS_LIMIT || '2000', 10);
  const handledOnboardingLimit = Number.parseInt(process.env.ROUTER_HANDLED_ONBOARDING_KEYS_LIMIT || '2000', 10);
  const statePath = join(routerHome, 'router-event-worker-state.json');
  const handleMatrixEvents = matrixHandlingEnabled();

  if (!secretKey) {
    throw new Error('ROUTER_SECRET_KEY is required');
  }

  if (httpAgentModeEnabled()) {
    await startHttpAgentServer();
    return;
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
    if (!toolNames.has('router_poll_events')) {
      throw new Error('router_poll_events not available to this identity');
    }

    log(`Connected to MCP with ${tools.tools.length} tools`);
  }

  await reconnect();

  let state = await loadState(statePath);
  let cursor = Number.parseInt(String(state.cursor || 0), 10) || 0;
  if (!state.initialized) {
    try {
      const result = await client.callTool({
        name: 'router_poll_events',
        arguments: { cursor: Number.MAX_SAFE_INTEGER, limit: 1 },
      });
      const structured = result.structuredContent || {};
      cursor = parseCursor(structured.latest_cursor ?? structured.next_cursor ?? 0, 0);
      state.cursor = cursor;
      state.initialized = true;
      state.bootstrapped_at = new Date().toISOString();
      await saveState(statePath, state);
      log(`No saved cursor; starting from latest cursor ${cursor}`);
    } catch (error) {
      log(`Initial cursor bootstrap failed: ${formatError(error)}`);
      cursor = Number.MAX_SAFE_INTEGER;
      state.cursor = cursor;
      state.initialized = true;
      state.bootstrap_failed_at = new Date().toISOString();
      await saveState(statePath, state);
      log('No saved cursor; temporarily using high-water cursor to avoid replaying old events');
    }
  }
  log(`Starting event loop at cursor ${cursor}`);

  while (true) {
    let events;
    try {
      const result = await client.callTool({
        name: 'router_poll_events',
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

    const latestMentionByRoom = latestMatrixMentionIdsByRoom(events);

    for (const event of events) {
      const eventId = parseCursor(event.id, 0);
      const eventType = event.type;
      const data = event.data || {};

      if (eventType === 'platform_onboarding') {
        if (data.platform === 'matrix' && !handleMatrixEvents) {
          log(`Skipping Matrix onboarding event ${eventId}; ROUTER_AGENT_HANDLES_MATRIX is disabled`);
          cursor = Math.max(cursor, eventId);
          state.cursor = cursor;
          await saveState(statePath, state);
          continue;
        }

        const key = onboardingKey(event);
        if (hasHandledOnboarding(state, key)) {
          log(`Skipping already-handled onboarding event ${eventId} for ${key}`);
          cursor = Math.max(cursor, eventId);
          state.cursor = cursor;
          await saveState(statePath, state);
          continue;
        }

        const ageMs = Date.now() - eventTimestamp(event);
        if (maxEventAgeMs > 0 && ageMs > maxEventAgeMs) {
          log(`Skipping stale onboarding event ${eventId}; age=${Math.round(ageMs / 1000)}s`);
          cursor = Math.max(cursor, eventId);
          state.cursor = cursor;
          await saveState(statePath, state);
          continue;
        }

        log(`Processing platform_onboarding ${eventId} for ${data.platform_user_id || 'unknown'} on ${data.platform || 'unknown'}`);

        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);

        try {
          await runOnboardingChat(event);
          rememberHandledOnboarding(state, key, handledOnboardingLimit);
          await saveState(statePath, state);
        } catch (error) {
          log(`Onboarding event ${eventId} handler error: ${formatError(error)}`);
          await sleep(Math.max(pollIntervalMs, 2000));
          continue;
        }
        continue;
      }

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

      if (!handleMatrixEvents) {
        log(`Skipping Matrix mention ${eventId}; ROUTER_AGENT_HANDLES_MATRIX is disabled`);
        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);
        continue;
      }

      const messageId = matrixMessageId(event);
      if (hasHandledMatrixMessage(state, messageId)) {
        log(`Skipping already-handled Matrix mention ${eventId} for message ${messageId}`);
        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);
        continue;
      }

      const latestInRoom = latestMentionByRoom.get(data.room_id);
      if (latestInRoom && eventId < latestInRoom) {
        log(`Skipping superseded Matrix mention ${eventId} in ${data.room_id}; newer mention ${latestInRoom} is queued`);
        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);
        continue;
      }

      const ageMs = Date.now() - eventTimestamp(event);
      if (maxEventAgeMs > 0 && ageMs > maxEventAgeMs) {
        log(`Skipping stale Matrix mention ${eventId} in ${data.room_id}; age=${Math.round(ageMs / 1000)}s`);
        cursor = Math.max(cursor, eventId);
        state.cursor = cursor;
        await saveState(statePath, state);
        continue;
      }

      log(
        `Processing Matrix platform_mention ${eventId} in ${data.room_id} from ${data.sender_id || 'unknown'} (dm=${data.is_dm ? 'yes' : 'no'})`,
      );

      cursor = Math.max(cursor, eventId);
      state.cursor = cursor;
      await saveState(statePath, state);

      try {
        await runAgentChat(event);
        rememberHandledMatrixMessage(state, messageId, handledMatrixMessageLimit);
        await saveState(statePath, state);
      } catch (error) {
        log(`Event ${eventId} handler error: ${formatError(error)}`);
        await sleep(Math.max(pollIntervalMs, 2000));
        continue;
      }
    }
  }
}

main().catch((error) => {
  log(`Fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});

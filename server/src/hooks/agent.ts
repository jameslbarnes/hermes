/**
 * Agent Hook Handlers
 *
 * These handlers implement the Router agent's core behavior:
 * "make connections between people and ideas"
 *
 * Triggered by notebook events and platform messages.
 * Uses the intelligence layer for scoring, sparks, and heat detection.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { HookContext } from './types.js';
import type { HookDispatcher } from './dispatcher.js';
import type { JournalEntry, Storage, User } from '../storage.js';
import { shouldRoute, evaluateEntry, type RecentPost } from '../intelligence/scoring.js';
import { detectSparks, evaluateSpark, getConnectionInfo, executeSpark, type SparkAction, type SparkCandidate } from '../intelligence/sparks.js';
import { RoomBufferManager, type BufferedMessage } from '../intelligence/heat.js';
import { generateLinkToken } from '../intelligence/link-tokens.js';
import { MatrixPlatform, type MatrixHistoryMessage } from '../platform/matrix.js';
import type { Platform } from '../platform/types.js';

// ── State ────────────────────────────────────────────────────

const recentPosts: RecentPost[] = [];
const MAX_RECENT_POSTS = 20;
const MIN_PLATFORM_CONTENT_LENGTH = 50;
const MATRIX_DEFAULT_FIREHOSE_CHANNEL_ID = 'bot-noise';
const MATRIX_DEFAULT_FIREHOSE_CHANNEL_NAME = 'Bot Noise';
const MATRIX_DEFAULT_FIREHOSE_DESCRIPTION = 'Router firehose for public notebook entries';
const SPARK_MATRIX_DEBOUNCE_WINDOW_MS = process.env.SPARK_MATRIX_DEBOUNCE_WINDOW_MS
  ? parseInt(process.env.SPARK_MATRIX_DEBOUNCE_WINDOW_MS)
  : 72 * 60 * 60 * 1000;
const SPARK_MATRIX_DEBOUNCE_LIMIT = process.env.SPARK_MATRIX_DEBOUNCE_LIMIT
  ? parseInt(process.env.SPARK_MATRIX_DEBOUNCE_LIMIT)
  : 160;

const SPARK_DEBOUNCE_STOP_WORDS = new Set([
  'about', 'after', 'again', 'already', 'also', 'around', 'because', 'between',
  'could', 'different', 'directly', 'entry', 'exactly', 'having', 'might',
  'notes', 'people', 'question', 'recent', 'recently', 'router', 'should',
  'spark', 'subject', 'their', 'there', 'these', 'thing', 'think', 'those',
  'through', 'together', 'would', 'worth',
]);

const roomBuffers = new RoomBufferManager();

export function hasLinkedPlatformAccount(
  user: Pick<User, 'linkedAccounts'> | null | undefined,
  platform: string,
): boolean {
  return !!user?.linkedAccounts?.some(account =>
    account.platform === platform
    && !!account.platformUserId
    && account.verified !== false,
  );
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

export function getUnexpectedSparkHandles(
  text: string | undefined,
  sourceHandle: string,
  targetHandle: string,
): string[] {
  if (!text) return [];

  const allowed = new Set([
    normalizeHandle(sourceHandle),
    normalizeHandle(targetHandle),
  ]);
  const unexpected = new Set<string>();
  const handlePattern = /(^|[\s([{"'`])@([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)(?=$|[\s)\]}:.,!?'"`])/g;

  for (const match of text.matchAll(handlePattern)) {
    const handle = normalizeHandle(match[2]);
    if (!allowed.has(handle)) {
      unexpected.add(handle);
    }
  }

  return [...unexpected];
}

function tokenizeSparkDebounceText(text: string | undefined): string[] {
  return (text || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{3,}/g)
    ?.map(term => term.replace(/^-+|-+$/g, ''))
    .filter(term => term.length >= 4 && !SPARK_DEBOUNCE_STOP_WORDS.has(term))
    .slice(0, 80) || [];
}

export function getSparkDebounceTopicTerms(
  action: Pick<SparkAction, 'reason'>,
  candidate: Pick<SparkCandidate, 'overlapTopics' | 'matchingEntries'>,
  sourceEntry: Pick<JournalEntry, 'content' | 'topicHints' | 'keywords'>,
  maxTerms = 16,
): string[] {
  const scores = new Map<string, number>();
  const add = (terms: string[], weight: number) => {
    for (const term of terms) {
      scores.set(term, (scores.get(term) || 0) + weight);
    }
  };

  add(tokenizeSparkDebounceText(candidate.overlapTopics.join(' ')), 5);
  add(tokenizeSparkDebounceText([...(sourceEntry.topicHints || []), ...(sourceEntry.keywords || [])].join(' ')), 4);
  add(tokenizeSparkDebounceText(action.reason), 3);
  add(tokenizeSparkDebounceText(sourceEntry.content), 2);
  add(tokenizeSparkDebounceText(candidate.matchingEntries.map(e => e.content).join(' ')), 1);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
    .slice(0, maxTerms);
}

function messageMatchesSparkTerms(message: MatrixHistoryMessage, terms: string[]): string[] {
  const text = message.text.toLowerCase();
  return terms.filter(term => text.includes(term));
}

export function findRecentMatrixSparkConversation(
  messages: MatrixHistoryMessage[],
  sourceHandle: string,
  targetHandle: string,
  terms: string[],
): { roomId: string; roomName: string; matchedTerms: string[]; sourceCount: number; targetCount: number } | null {
  if (terms.length === 0) return null;

  const source = normalizeHandle(sourceHandle);
  const target = normalizeHandle(targetHandle);
  const byRoom = new Map<string, MatrixHistoryMessage[]>();
  for (const message of messages) {
    if (message.isDM) continue;
    const sender = message.senderHandle ? normalizeHandle(message.senderHandle) : '';
    if (sender !== source && sender !== target) continue;
    const existing = byRoom.get(message.roomId) || [];
    existing.push(message);
    byRoom.set(message.roomId, existing);
  }

  for (const [roomId, roomMessages] of byRoom) {
    const sourceMessages = roomMessages.filter(message => normalizeHandle(message.senderHandle || '') === source);
    const targetMessages = roomMessages.filter(message => normalizeHandle(message.senderHandle || '') === target);
    if (sourceMessages.length === 0 || targetMessages.length === 0) continue;

    const matchedTerms = new Set<string>();
    const matchedHandles = new Set<string>();
    for (const message of roomMessages) {
      const hits = messageMatchesSparkTerms(message, terms);
      if (hits.length === 0) continue;
      hits.forEach(term => matchedTerms.add(term));
      matchedHandles.add(normalizeHandle(message.senderHandle || ''));
    }

    const pairIsActivelyTalking = roomMessages.length >= 4 && matchedTerms.size >= 2;
    const bothUsedTopicTerms = matchedHandles.has(source) && matchedHandles.has(target);
    if (bothUsedTopicTerms || pairIsActivelyTalking) {
      return {
        roomId,
        roomName: roomMessages[0]?.roomAlias || roomMessages[0]?.roomName || roomId,
        matchedTerms: [...matchedTerms],
        sourceCount: sourceMessages.length,
        targetCount: targetMessages.length,
      };
    }
  }

  return null;
}

async function findRecentMatrixSparkConversationForAction(
  action: SparkAction,
  candidate: SparkCandidate,
  sourceEntry: JournalEntry,
  matrixPlatform: MatrixPlatform,
): Promise<ReturnType<typeof findRecentMatrixSparkConversation>> {
  const queryable = matrixPlatform as MatrixPlatform & {
    queryRecentMessages?: MatrixPlatform['queryRecentMessages'];
  };
  if (typeof queryable.queryRecentMessages !== 'function') return null;

  const terms = getSparkDebounceTopicTerms(action, candidate, sourceEntry);
  if (terms.length === 0) return null;

  const messages = await queryable.queryRecentMessages({
    since: Date.now() - SPARK_MATRIX_DEBOUNCE_WINDOW_MS,
    limit: SPARK_MATRIX_DEBOUNCE_LIMIT,
    perRoomLimit: 40,
    includeDMs: false,
    spaceOnly: false,
    botScope: true,
  }).catch(() => []);

  return findRecentMatrixSparkConversation(messages, action.sourceHandle, action.targetHandle, terms);
}

function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function matrixMentionsHandledByHermesAgent(): boolean {
  const raw = process.env.HERMES_AGENT_HANDLES_MATRIX;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'remote'].includes(raw.trim().toLowerCase());
}

export function getPublishedEntryFromEvent(
  storedEntry: JournalEntry | null,
  eventData: Record<string, any>,
): JournalEntry | null {
  if (storedEntry) return storedEntry;

  const snapshot = eventData.entry;
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (typeof snapshot.id !== 'string') return null;
  if (typeof snapshot.pseudonym !== 'string') return null;
  if (snapshot.client !== 'desktop' && snapshot.client !== 'mobile' && snapshot.client !== 'code') return null;
  if (typeof snapshot.content !== 'string') return null;
  if (typeof snapshot.timestamp !== 'number') return null;

  return snapshot as JournalEntry;
}

export function getMatrixRoutingTargets(entry: JournalEntry): { postToFeed: boolean; channelDests: string[] } {
  if (entry.aiOnly === true || entry.humanVisible === false) return { postToFeed: false, channelDests: [] };
  if (entry.content.length < MIN_PLATFORM_CONTENT_LENGTH) return { postToFeed: false, channelDests: [] };

  const destinations = entry.to || [];
  const channelDests = destinations
    .filter(dest => dest.startsWith('#'))
    .map(dest => dest.slice(1));

  if (entry.visibility === 'private' && channelDests.length === 0) {
    return { postToFeed: false, channelDests: [] };
  }

  return {
    postToFeed: destinations.length === 0,
    channelDests,
  };
}

type PendingEntryStorage = Storage & {
  getAllPendingEntries(): JournalEntry[];
  isPending(id: string): boolean;
  publishEntry(id: string): Promise<JournalEntry | null>;
};

function hasPendingEntryApi(storage: Storage): storage is PendingEntryStorage {
  const candidate = storage as Partial<PendingEntryStorage>;
  return typeof candidate.getAllPendingEntries === 'function'
    && typeof candidate.isPending === 'function'
    && typeof candidate.publishEntry === 'function';
}

function getVerifiedLinkedAccount(user: User | null | undefined, platformName: string): string | null {
  return user?.linkedAccounts?.find(account =>
    account.platform === platformName
    && !!account.platformUserId
    && account.verified !== false,
  )?.platformUserId || null;
}

function entryBelongsToUser(entry: JournalEntry, user: User): boolean {
  if (entry.handle && normalizeHandle(entry.handle) === normalizeHandle(user.handle)) return true;
  return !!user.legacyPseudonym && entry.pseudonym === user.legacyPseudonym;
}

async function findUserByLinkedAccount(storage: Storage, platformName: string, platformUserId: string): Promise<User | null> {
  const users = await storage.getAllUsers();
  return users.find(user =>
    user.linkedAccounts?.some(account =>
      account.platform === platformName
      && account.platformUserId === platformUserId
      && account.verified !== false,
    ),
  ) || null;
}

async function findEntryAuthorUser(storage: Storage, entry: JournalEntry): Promise<User | null> {
  if (entry.handle) {
    return storage.getUser(entry.handle).catch(() => null);
  }

  const users = await storage.getAllUsers().catch(() => []);
  return users.find(user => user.legacyPseudonym === entry.pseudonym) || null;
}

function formatRelativePublishTime(publishAt: number | undefined): string {
  if (!publishAt) return 'soon';

  const ms = publishAt - Date.now();
  if (ms <= 0) return 'now';

  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function truncateForMatrix(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getPublishCommandTarget(query: string): string | 'latest' | null {
  const tokens = query.split(/\s+/).filter(Boolean);
  const command = tokens[0];
  if (command !== 'publish' && command !== '/publish') return null;

  const explicitId = tokens
    .slice(1)
    .find(token => /^[a-z0-9]+-[a-z0-9]+$/.test(token));
  if (explicitId) return explicitId;

  const args = tokens.slice(1);
  if (args.length === 0 || args.some(token => token === 'latest' || token === 'now')) {
    return 'latest';
  }

  return null;
}

export async function notifyLinkedMatrixPendingEntry(ctx: HookContext, entry: JournalEntry): Promise<void> {
  if (!entry.publishAt || entry.publishAt <= Date.now()) return;

  const matrix = ctx.platforms.find(platform => platform.name === 'matrix');
  if (!matrix) return;

  const author = await findEntryAuthorUser(ctx.storage, entry);
  const matrixUserId = getVerifiedLinkedAccount(author, 'matrix');
  if (!matrixUserId) return;

  const destinationLine = entry.to && entry.to.length > 0
    ? `\nDestinations: ${entry.to.join(', ')}`
    : '';
  const visibilityLine = entry.aiOnly || entry.humanVisible === false
    ? '\nVisibility: AI-only'
    : '';
  const preview = truncateForMatrix(entry.content, 1800);
  const message = [
    `A Hermes post is pending.`,
    ``,
    `Entry: \`${entry.id}\``,
    `Publishes: ${formatRelativePublishTime(entry.publishAt)}${destinationLine}${visibilityLine}`,
    ``,
    preview,
    ``,
    `Reply \`publish ${entry.id}\` to publish it now, or \`publish latest\` for your newest pending post.`,
  ].join('\n');

  await matrix.sendDM(matrixUserId, message);
}

export async function handlePendingPublishCommand(params: {
  storage: Storage;
  platform: Platform;
  platformName: string;
  roomId: string;
  messageId?: string;
  senderId?: string;
  query: string;
}): Promise<boolean> {
  const command = params.query.split(/\s+/).filter(Boolean)[0];
  if (command !== 'publish' && command !== '/publish') return false;

  const target = getPublishCommandTarget(params.query);
  const reply = (text: string) => params.platform.sendMessage(params.roomId, text, { replyTo: params.messageId });
  if (!target) {
    await reply('Use `publish <entry id>` or `publish latest`.');
    return true;
  }

  if (!params.senderId) {
    await reply('I could not identify your Matrix account for this command.');
    return true;
  }

  const user = await findUserByLinkedAccount(params.storage, params.platformName, params.senderId);
  if (!user) {
    await reply('Link this Matrix account first by sending `link`, then run the Hermes linking tool with the code.');
    return true;
  }

  if (!hasPendingEntryApi(params.storage)) {
    await reply('This Hermes deployment does not have a pending-post buffer enabled.');
    return true;
  }

  let entry: JournalEntry | null = null;
  if (target === 'latest') {
    const pending = params.storage.getAllPendingEntries()
      .filter(candidate => entryBelongsToUser(candidate, user))
      .sort((a, b) => b.timestamp - a.timestamp);
    entry = pending[0] || null;
    if (!entry) {
      await reply('You do not have any pending Hermes posts.');
      return true;
    }
  } else {
    entry = await params.storage.getEntry(target);
    if (!entry || !params.storage.isPending(target)) {
      await reply(`Entry ${target} is not pending. It may already be published or deleted.`);
      return true;
    }
    if (!entryBelongsToUser(entry, user)) {
      await reply('You can only publish your own pending posts.');
      return true;
    }
  }

  const published = await params.storage.publishEntry(entry.id);
  if (!published) {
    await reply(`Entry ${entry.id} could not be published. It may already be gone from the buffer.`);
    return true;
  }

  const url = `${process.env.BASE_URL || 'https://hermes.teleport.computer'}/entry.html?id=${encodeURIComponent(published.id)}`;
  const publishedLabel = published.id === entry.id ? published.id : `${entry.id} as ${published.id}`;
  await reply(`Published entry ${publishedLabel}.\n\n${url}`);
  return true;
}

// ── Registration ─────────────────────────────────────────────

/**
 * Register all agent hooks with the dispatcher.
 */
export function registerAgentHooks(dispatcher: HookDispatcher): void {
  dispatcher.register({
    id: 'agent:entry-published',
    triggers: ['entry_published'],
    handler: onEntryPublished,
    priority: 50,
  });

  dispatcher.register({
    id: 'agent:entry-staged',
    triggers: ['entry_staged'],
    handler: onEntryStaged,
    priority: 50,
  });

  dispatcher.register({
    id: 'agent:platform-message',
    triggers: ['platform_message'],
    handler: onPlatformMessage,
    priority: 50,
  });

  dispatcher.register({
    id: 'agent:platform-mention',
    triggers: ['platform_mention'],
    handler: onPlatformMention,
    priority: 50,
  });
}

// ── Handlers ─────────────────────────────────────────────────

/**
 * Entry published → evaluate for routing and spark detection.
 */
async function onEntryPublished(ctx: HookContext): Promise<void> {
  const { event, storage, platforms } = ctx;
  const entryId = event.data.entry_id;
  if (!entryId) return;

  const storedEntry = await storage.getEntry(entryId);
  const entry = getPublishedEntryFromEvent(storedEntry, event.data);
  if (!entry) {
    console.warn(`[Agent] Published entry ${entryId} not found in storage and no usable snapshot was attached`);
    return;
  }
  if (!storedEntry) {
    console.warn(`[Agent] Published entry ${entryId} missing from storage lookup, using event snapshot`);
  }

  const authorDisplay = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  console.log(`[Agent] Entry published by ${authorDisplay}: ${entry.content.substring(0, 80)}...`);

  const anthropic = getAnthropic();

  // ── Routing: should this entry be surfaced on platforms? ──
  let evaluationKeywords: string[] | undefined;
  const matrixTargets = getMatrixRoutingTargets(entry);
  const shouldEvaluateForPlatforms = shouldRoute(entry) || matrixTargets.channelDests.length > 0;

  let evaluation: { route: boolean; hook?: string; score?: number; keywords?: string[] } = { route: false };
  if (shouldEvaluateForPlatforms) {
    const evaluableEntry = entry.to && entry.to.length > 0
      ? { ...entry, to: undefined }
      : entry;
    evaluation = await evaluateEntry(evaluableEntry, anthropic, storage, recentPosts);
    evaluationKeywords = evaluation.keywords;
  }

  const shouldRecordRecentPost = evaluation.route || matrixTargets.postToFeed || matrixTargets.channelDests.length > 0;
  if (shouldRecordRecentPost) {
    recentPosts.push({
      author: authorDisplay,
      contentSnippet: entry.content.slice(0, 200),
      hook: evaluation.hook,
    });
    if (recentPosts.length > MAX_RECENT_POSTS) recentPosts.shift();
  }

  for (const platform of platforms) {
    try {
      if (platform instanceof MatrixPlatform) {
        if (matrixTargets.postToFeed || matrixTargets.channelDests.length > 0) {
          console.log(
            `[Agent] Matrix routing plan for ${entry.id}: feed=${matrixTargets.postToFeed} channels=${matrixTargets.channelDests.join(',') || '(none)'}`
          );
        }

        if (matrixTargets.channelDests.length > 0) {
          for (const channelId of matrixTargets.channelDests) {
            const roomId = await platform.ensureChannelRoom(channelId, channelId);
            await platform.postEntry(roomId, entry, evaluation.hook);
            console.log(`[Agent] Posted entry to #${channelId} on Matrix`);
          }
        }

        if (matrixTargets.postToFeed) {
          const feedRoomId = await platform.ensureChannelRoom(
            MATRIX_DEFAULT_FIREHOSE_CHANNEL_ID,
            MATRIX_DEFAULT_FIREHOSE_CHANNEL_NAME,
            MATRIX_DEFAULT_FIREHOSE_DESCRIPTION,
          );
          await platform.postEntry(feedRoomId, entry, evaluation.hook);
          console.log(`[Agent] Posted entry to #${MATRIX_DEFAULT_FIREHOSE_CHANNEL_ID} on Matrix`);
        }
      } else if (evaluation.route) {
        const content = evaluation.hook || entry.content;
        console.log(`[Agent] Routing to ${platform.name}: ${content.substring(0, 80)}...`);
      }
    } catch (err) {
      console.error(`[Agent] Failed to route to ${platform.name}:`, err);
    }
  }

  // ── Sparks: does this entry create connections? ──
  if (entry.handle && anthropic) {
    try {
      const candidates = await detectSparks(entry, storage, evaluationKeywords);
      if (candidates.length > 0) {
        console.log(`[Agent] ${candidates.length} spark candidates for ${authorDisplay}`);

        // Evaluate top candidates
        for (const candidate of candidates.slice(0, 3)) {
          const connectionInfo = await getConnectionInfo(entry.handle, candidate.handle, platforms, storage);
          const action = await evaluateSpark(entry, candidate, connectionInfo, anthropic);

          if (action.action !== 'skip') {
            console.log(`[Agent] Spark: ${action.action} @${action.sourceHandle} ↔ @${action.targetHandle} (${action.confidence}): ${action.reason}`);
            await executeSparkWithContext(action, candidate, entry, platforms, storage);
          }
        }
      }
    } catch (err) {
      console.error('[Agent] Spark detection failed:', err);
    }
  }
}

/**
 * Entry staged → log for now, future: content moderation.
 */
async function onEntryStaged(ctx: HookContext): Promise<void> {
  const { event, storage } = ctx;
  const author = event.data.author_handle || event.data.author_pseudonym;
  console.log(`[Agent] Entry staged by ${author}: ${event.data.entry_id}`);

  const entryId = event.data.entry_id;
  if (!entryId) return;

  try {
    const entry = await storage.getEntry(entryId);
    if (!entry) return;
    await notifyLinkedMatrixPendingEntry(ctx, entry);
  } catch (err) {
    console.error('[Agent] Failed to notify linked Matrix account for staged entry:', err);
  }
}

/**
 * Platform message → buffer, heat detection, writeback evaluation.
 */
async function onPlatformMessage(ctx: HookContext): Promise<void> {
  const { event, storage, platforms } = ctx;
  const { platform: platformName, room_id, text, sender_handle, sender_id, timestamp } = event.data;

  if (!text || !room_id) return;

  // ── Reply-to-entry writeback ──────────────────────────────
  // If someone replies to a notebook entry in Matrix, write it
  // back as a threaded reply in the notebook
  const replyToEntryId = event.data.reply_to_entry_id;
  if (replyToEntryId && sender_handle) {
    try {
      const keyHash = await findKeyHashForHandle(sender_handle, storage);
      if (keyHash) {
        await storage.addEntry({
          pseudonym: sender_handle,
          handle: sender_handle,
          client: 'code' as const,
          content: text,
          timestamp: Date.now(),
          inReplyTo: replyToEntryId,
        });
        console.log(`[Agent] Wrote Matrix reply from @${sender_handle} as notebook reply to ${replyToEntryId}`);
      }
    } catch (err) {
      console.error('[Agent] Failed to write reply to notebook:', err);
    }
  }

  // Buffer the message
  const buffer = roomBuffers.getBuffer(room_id);
  const msg: BufferedMessage = {
    text,
    senderName: sender_handle || sender_id || 'unknown',
    senderId: sender_id,
    timestamp: timestamp || Date.now(),
    platform: platformName,
    roomId: room_id,
  };
  buffer.push(msg);

  // Check heat — is this conversation worth evaluating?
  const heat = buffer.measureHeat();
  if (heat.isHot && buffer.messagesSinceCheck >= 10) {
    buffer.resetCheckCounter();
    console.log(`[Agent] Hot conversation in ${room_id} on ${platformName}: ${heat.uniqueSenders} senders, ${heat.recentCount} messages`);

    // Future: detect sparks from conversation topics
    // Future: evaluate for notebook writeback
  }
}

/**
 * Platform mention → search notebook, respond.
 */
async function onPlatformMention(ctx: HookContext): Promise<void> {
  const { event, storage, platforms } = ctx;
  const { platform: platformName, room_id, text, sender_handle, sender_id, message_id, is_dm } = event.data;

  if (!text || !room_id) return;

  const platform = platforms.find(p => p.name === platformName);
  if (!platform) return;

  console.log(`[Agent] ${is_dm ? 'DM' : 'Mention'} on ${platformName} by ${sender_id || 'unknown'}: ${text.substring(0, 80)}...`);

  // Extract the query (remove @mentions, slashes, etc.)
  const query = text.replace(/@\w+/g, '').trim().toLowerCase();
  const firstWord = query.split(/\s+/)[0];

  // ── Link command ──────────────────────────────────────────
  // User DMs "link" to get a code that ties their platform account
  // to their Hermes identity (completed via MCP tool).
  if ((firstWord === 'link' || firstWord === '/link') && sender_id) {
    const code = generateLinkToken(platformName, sender_id);
    const reply = [
      `Your one-time link code: **${code}**`,
      '',
      `In the Hermes notebook, tell Claude:`,
      `"Link my ${platformName} account with code ${code}"`,
      '',
      `Claude should use the \`hermes_link_platform\` tool automatically.`,
      `If you haven't created a Hermes handle yet, do that first, then run the link step again.`,
      '',
      `(expires in 10 minutes)`,
    ].join('\n');
    await platform.sendMessage(room_id, reply, { replyTo: message_id });
    console.log(`[Agent] Generated link code ${code} for ${sender_id}`);
    return;
  }

  // ── Help command ──────────────────────────────────────────
  if (firstWord === 'help' || firstWord === '/help') {
    const helpText = [
      `I'm the Router — I connect people and ideas from the notebook.`,
      ``,
      `Commands:`,
      `• **link** — get a code to connect this ${platformName} account to your Hermes identity`,
      `• **publish <entry id>** — publish one of your pending Hermes posts`,
      `• **help** — show this message`,
      ``,
      `Or just ask me a question about the notebook and I'll search it.`,
    ].join('\n');
    await platform.sendMessage(room_id, helpText, { replyTo: message_id });
    return;
  }

  if (platformName === 'matrix' && is_dm) {
    const handled = await handlePendingPublishCommand({
      storage,
      platform,
      platformName,
      roomId: room_id,
      messageId: message_id,
      senderId: sender_id,
      query,
    });
    if (handled) return;
  }

  // Matrix DMs/@mentions should be handled by the external Hermes agent
  // when that path is enabled. Keep link/help local, but otherwise let the
  // event queue be the handoff boundary.
  if (platformName === 'matrix' && matrixMentionsHandledByHermesAgent()) {
    console.log(
      `[Agent] Deferring Matrix ${is_dm ? 'DM' : 'mention'} in ${room_id} to hermes-agent`,
    );
    return;
  }

  if (query.length < 3) {
    await platform.sendMessage(room_id, "Say `help` for what I can do, or ask me anything about the notebook.", {
      replyTo: message_id,
    });
    return;
  }

  try {
    const results = await storage.searchEntries(query, 5);
    if (results.length === 0) {
      await platform.sendMessage(room_id, `No entries found for "${query}".`, { replyTo: message_id });
      return;
    }

    const summary = results.map(e => {
      const author = e.handle ? `@${e.handle}` : e.pseudonym;
      const snippet = e.content.substring(0, 150).replace(/\n/g, ' ');
      return `**${author}**: ${snippet}...`;
    }).join('\n\n');

    await platform.sendMessage(room_id, summary, { replyTo: message_id });
  } catch (err) {
    console.error('[Agent] Mention handler error:', err);
    await platform.sendMessage(room_id, 'Sorry, something went wrong searching the notebook.', { replyTo: message_id });
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function findKeyHashForHandle(handle: string, storage: import('../storage.js').Storage): Promise<string | null> {
  try {
    const user = await storage.getUser(handle);
    return user?.secretKeyHash || null;
  } catch {
    return null;
  }
}

// ── Spark Execution with Rich Context ────────────────────────

/**
 * Execute a spark action with full notebook context.
 * On Matrix, this creates rooms with structured spark state events
 * that the Router Client renders as introduction cards.
 */
async function executeSparkWithContext(
  action: SparkAction,
  candidate: SparkCandidate,
  sourceEntry: JournalEntry,
  platforms: import('../platform/types.js').Platform[],
  storage?: Storage,
  options: { debounceMatrix?: boolean } = {},
): Promise<void> {
  if (action.action === 'skip') return;

  const matrixPlatform = platforms.find(p => p instanceof MatrixPlatform) as MatrixPlatform | undefined;

  if (matrixPlatform && storage) {
    const [sourceUser, targetUser] = await Promise.all([
      storage.getUser(action.sourceHandle),
      storage.getUser(action.targetHandle),
    ]);
    const sourceLinked = hasLinkedPlatformAccount(sourceUser, 'matrix');
    const targetLinked = hasLinkedPlatformAccount(targetUser, 'matrix');

    if (!sourceLinked || !targetLinked) {
      console.log(
        `[Agent] Skipping spark outreach for @${action.sourceHandle} ↔ @${action.targetHandle}: ` +
        `linked Matrix required (source=${sourceLinked}, target=${targetLinked})`,
      );
      return;
    }
  }

  let warmMessage = action.message;

  const unexpectedHandles = getUnexpectedSparkHandles(
    [action.reason, warmMessage].filter(Boolean).join('\n'),
    action.sourceHandle,
    action.targetHandle,
  );
  if (unexpectedHandles.length > 0) {
    console.warn(
      `[Agent] Skipping spark @${action.sourceHandle} ↔ @${action.targetHandle}: ` +
      `message mentioned unrelated handles (${unexpectedHandles.map(h => `@${h}`).join(', ')})`,
    );
    return;
  }

  if (matrixPlatform && options.debounceMatrix !== false) {
    const existingConversation = await findRecentMatrixSparkConversationForAction(
      action,
      candidate,
      sourceEntry,
      matrixPlatform,
    );
    if (existingConversation) {
      console.log(
        `[Agent] Skipping spark @${action.sourceHandle} ↔ @${action.targetHandle}: ` +
        `recent Matrix conversation already active in ${existingConversation.roomName} ` +
        `(terms=${existingConversation.matchedTerms.slice(0, 5).join(', ') || 'none'})`,
      );
      return;
    }
  }

  if (matrixPlatform && storage && (action.action === 'introduce' || action.action === 'nudge')) {
    const pairRoom = await ensureSparkPairRoom(
      action,
      sourceEntry,
      candidate,
      matrixPlatform,
      storage,
    );

    if (warmMessage) {
      await matrixPlatform.sendMessage(pairRoom.id, warmMessage);
    }

    if (pairRoom.created) {
      console.log(`[Agent] Spark room created: ${pairRoom.id}`);
    }
    return;
  }

  // For suggest/nudge, use the warm message if available
  if (warmMessage) {
    action = { ...action, message: warmMessage };
  }
  await executeSpark(action, platforms, 'router');
}

export async function triggerManualSpark(
  sourceHandle: string,
  targetHandle: string,
  reason: string,
  platforms: import('../platform/types.js').Platform[],
  storage: Storage,
  message?: string,
): Promise<void> {
  const [sourceEntries, targetEntries] = await Promise.all([
    storage.getEntriesByHandle(sourceHandle, 1),
    storage.getEntriesByHandle(targetHandle, 3),
  ]);

  const sourceEntry = sourceEntries[0] || {
    id: `manual-spark-${Date.now()}`,
    handle: sourceHandle,
    pseudonym: `@${sourceHandle}`,
    client: 'desktop' as const,
    content: reason,
    timestamp: Date.now(),
  };

  const candidate: import('../intelligence/sparks.js').SparkCandidate = {
    handle: targetHandle,
    matchingEntries: targetEntries,
    overlapTopics: [],
  };

  const action: SparkAction = {
    action: 'introduce',
    confidence: 'high',
    sourceHandle,
    targetHandle,
    reason,
    message,
  };

  await executeSparkWithContext(action, candidate, sourceEntry, platforms, storage, { debounceMatrix: false });
}

async function ensureSparkPairRoom(
  action: SparkAction,
  sourceEntry: JournalEntry,
  candidate: SparkCandidate,
  matrixPlatform: MatrixPlatform,
  storage: Storage,
): Promise<{ id: string; created: boolean }> {
  const existingRoomId = action.existingRoomId
    || await storage.getSparkPairRoom(action.sourceHandle, action.targetHandle);
  if (existingRoomId) {
    const matchesPair = await matrixPlatform.isSparkRoomForPair(
      existingRoomId,
      action.sourceHandle,
      action.targetHandle,
    );
    if (matchesPair) {
      await matrixPlatform.attachRoomToSpace(existingRoomId, `@${action.sourceHandle} ↔ @${action.targetHandle}`);
      return { id: existingRoomId, created: false };
    }
    console.warn(
      `[Agent] Ignoring stale spark room ${existingRoomId} for ` +
      `@${action.sourceHandle} ↔ @${action.targetHandle}: Matrix room state does not match pair`,
    );
  }

  const room = await matrixPlatform.createRoom(
    `@${action.sourceHandle} ↔ @${action.targetHandle}`,
    {
      type: 'group',
      invite: [action.sourceHandle, action.targetHandle],
      topic: action.reason,
      encrypted: true,
      attachToSpace: true,
    },
  );

  await storage.setSparkPairRoom(action.sourceHandle, action.targetHandle, room.id);

  await matrixPlatform.postSparkContext(room.id, {
    sourceHandle: action.sourceHandle,
    targetHandle: action.targetHandle,
    reason: action.reason,
    evidence: [
      {
        entryId: sourceEntry.id,
        author: `@${action.sourceHandle}`,
        snippet: sourceEntry.content.substring(0, 200),
      },
      ...candidate.matchingEntries.slice(0, 2).map(e => ({
        entryId: e.id,
        author: `@${candidate.handle}`,
        snippet: e.content.substring(0, 200),
      })),
    ],
  });

  return { id: room.id, created: true };
}

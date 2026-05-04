/**
 * Cron Hook Handlers
 *
 * Scheduled tasks: daily digest and channel room initialization.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry, User } from '../storage.js';
import { MatrixPlatform, type MatrixHistoryMessage } from '../platform/matrix.js';
import { getPlatform } from '../platform/registry.js';

// ── Digest ───────────────────────────────────────────────────

export const GLOBAL_DIGEST_MODEL = 'claude-opus-4-7';
export const PERSONALIZED_DIGEST_MODEL = 'claude-opus-4-7';

const DIGEST_PROMPT = `You are the Router, writing the global daily digest for the shared notebook.

This is not a personal digest and not a raw feed recap. It is the shared "state of the notebook" for the whole community.

Write like the editor of a small, smart newspaper. Group entries by theme, highlight surprising connections, note who's writing about what, and explain why the day mattered.

Some context may come from Matrix room discussion snippets. Treat those as live conversation context, not notebook entries. Do not quote private DMs in the global digest.

Structure:
- Lead with the strongest pattern or surprise
- 3-5 short thematic sections
- Note notable new/returning authors if relevant
- Include one "worth watching" note when there is an emerging trend or unresolved question

Cite @handles. Be specific, but do not list every entry. Keep it under 700 words. Write in present tense.

If there were fewer than 3 entries, write a brief note instead of a full digest.`;

const PERSONALIZED_DIGEST_PROMPT = `You are the Router, writing a personalized daily digest for a specific person.

Use the person's actual notebook corpus and follow graph as context. Do not rely on a precomputed profile or abstract labels.

Write their digest with THEM in mind. Lead with what matters to THEM — entries from people they follow, work that overlaps with theirs, problems they could help solve (or that could help them).

Some context may come from Matrix room discussion snippets. Public room snippets are community context; private DM snippets are only included when the recipient is in that DM.

Structure:
- "For you" section: entries directly relevant to their current work or interests
- "From your network" section: what people they follow wrote about
- "You might want to meet" section: if someone new wrote about something they care about, suggest the connection with a specific reason

Voice: you're a thoughtful friend who reads everything and knows what this person cares about. Not a news aggregator.

Keep it under 500 words. Cite @handles. Be specific about WHY something is relevant to them.`;

export interface GlobalDigestResult {
  posted: boolean;
  entryCount: number;
  includedEntryCount: number;
  matrixMessageCount?: number;
  date: string;
  roomId?: string;
  skipped?: string;
  failed?: boolean;
}

function getUtcDayRange(date: string): { start: number; end: number } {
  const start = new Date(`${date}T00:00:00.000Z`).getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function getYesterdayUtcDate(now = new Date()): string {
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  ));
  return yesterday.toISOString().slice(0, 10);
}

function isChannelDestination(dest: string): boolean {
  return dest.trim().startsWith('#');
}

function isPublicDigestEntry(entry: JournalEntry): boolean {
  if (entry.aiOnly === true || entry.humanVisible === false) return false;
  if (entry.visibility === 'private' || entry.visibility === 'ai-only') return false;
  if (entry.to && entry.to.length > 0 && !entry.to.every(isChannelDestination)) return false;
  return true;
}

function selectEntriesForGlobalDigest(entries: JournalEntry[], maxEntries = 80): JournalEntry[] {
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length <= maxEntries) return sorted;
  return sorted.slice(sorted.length - maxEntries);
}

function formatEntryForGlobalDigestPrompt(entry: JournalEntry, max = 420): string {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const time = new Date(entry.timestamp).toISOString().slice(11, 16);
  const content = entry.content.trim() || '[no text content]';
  const channels = [
    ...(entry.to || []).filter(isChannelDestination),
    entry.channel ? `#${entry.channel}` : '',
  ].filter(Boolean);
  const metadata = [
    channels.length > 0 ? `channels: ${channels.join(', ')}` : '',
    entry.topicHints?.length ? `topics: ${entry.topicHints.join(', ')}` : '',
    entry.isReflection ? 'reflection' : '',
  ].filter(Boolean);

  return [
    `[${time}] ${author}${metadata.length ? ` (${metadata.join('; ')})` : ''}`,
    content.slice(0, max) + (content.length > max ? '...' : ''),
  ].join('\n');
}

function formatMatrixMessageForDigestPrompt(message: MatrixHistoryMessage, max = 320): string {
  const time = new Date(message.timestamp).toISOString().slice(11, 16);
  const sender = message.senderHandle ? `@${message.senderHandle}` : message.senderId;
  const room = message.isDM
    ? `DM ${message.roomName}`
    : (message.roomAlias || message.roomName || message.roomId);
  const content = message.text.replace(/\s+/g, ' ').trim();
  return `[${time}] ${room} ${sender}: ${content.slice(0, max)}${content.length > max ? '...' : ''}`;
}

function formatMatrixMessagesForDigestPrompt(messages: MatrixHistoryMessage[], maxMessages = 80): string {
  return messages
    .slice(0, maxMessages)
    .map(message => formatMatrixMessageForDigestPrompt(message))
    .join('\n');
}

async function queryMatrixDigestMessages(
  matrix: MatrixPlatform,
  opts: {
    since: number;
    until: number;
    limit: number;
    includeDMs?: boolean;
    onlyDMs?: boolean;
    viewerUserId?: string;
  },
): Promise<MatrixHistoryMessage[]> {
  const queryable = matrix as MatrixPlatform & {
    queryRecentMessages?: MatrixPlatform['queryRecentMessages'];
  };

  if (typeof queryable.queryRecentMessages !== 'function') return [];

  try {
    return await queryable.queryRecentMessages({
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      includeDMs: opts.includeDMs,
      onlyDMs: opts.onlyDMs,
      viewerUserId: opts.viewerUserId,
      spaceOnly: !opts.onlyDMs,
    });
  } catch (error) {
    console.warn('[Cron] Failed to query Matrix history for digest:', error);
    return [];
  }
}

function getEntryContributor(entry: JournalEntry): string {
  return entry.handle ? `@${entry.handle}` : entry.pseudonym;
}

async function maybeSaveDailySummary(
  storage: Storage,
  date: string,
  content: string,
  entries: JournalEntry[],
): Promise<void> {
  const summaryStorage = storage as Storage & {
    addDailySummary?: (summary: {
      date: string;
      content: string;
      timestamp: number;
      entryCount: number;
      pseudonyms: string[];
    }) => Promise<unknown>;
  };

  if (!summaryStorage.addDailySummary) return;

  await summaryStorage.addDailySummary({
    date,
    content,
    timestamp: Date.now(),
    entryCount: entries.length,
    pseudonyms: [...new Set(entries.map(getEntryContributor))],
  });
}

/**
 * Generate and post a global daily digest to Matrix #digest.
 * Called by the cron scheduler (typically 8am UTC).
 */
export async function generateDailyDigest(
  storage: Storage,
  opts?: { date?: string },
): Promise<GlobalDigestResult> {
  console.log('[Cron] Generating global daily digest...');

  const date = opts?.date || getYesterdayUtcDate();
  const { start: startOfDay, end: endOfDay } = getUtcDayRange(date);

  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) {
    console.log('[Cron] Skipping global digest: Matrix platform not connected');
    return { posted: false, entryCount: 0, includedEntryCount: 0, date, skipped: 'matrix-not-connected' };
  }

  const allEntries = await storage.getEntriesSince(startOfDay, 1000);
  const yesterdayEntries = allEntries.filter(e =>
    e.timestamp >= startOfDay && e.timestamp < endOfDay && isPublicDigestEntry(e)
  );
  const matrixMessages = await queryMatrixDigestMessages(matrix, {
    since: startOfDay,
    until: endOfDay,
    limit: 80,
  });

  if (yesterdayEntries.length === 0 && matrixMessages.length === 0) {
    console.log('[Cron] No public notebook or Matrix activity yesterday, skipping global digest');
    return { posted: false, entryCount: 0, includedEntryCount: 0, matrixMessageCount: 0, date, skipped: 'no-public-activity' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Cron] No ANTHROPIC_API_KEY, skipping global digest');
    return { posted: false, entryCount: yesterdayEntries.length, includedEntryCount: 0, matrixMessageCount: matrixMessages.length, date, skipped: 'missing-api-key' };
  }

  const anthropic = new Anthropic({ apiKey });
  const selectedEntries = selectEntriesForGlobalDigest(yesterdayEntries);

  // Format entries for the prompt
  const entrySummaries = selectedEntries
    .map(e => formatEntryForGlobalDigestPrompt(e))
    .join('\n\n---\n\n');
  const matrixSummaries = formatMatrixMessagesForDigestPrompt(matrixMessages);

  try {
    const response = await anthropic.messages.create({
      model: GLOBAL_DIGEST_MODEL,
      max_tokens: 1600,
      system: DIGEST_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `Date: ${date}`,
            `Public entries: ${yesterdayEntries.length}`,
            `Entries included below: ${selectedEntries.length}`,
            `Matrix room messages: ${matrixMessages.length}`,
            selectedEntries.length < yesterdayEntries.length
              ? `Note: high-volume day; this is the latest representative set of ${selectedEntries.length} entries. Still summarize the overall day from this evidence and mention that the day was high-volume.`
              : '',
            '',
            '<entries>',
            entrySummaries || '[no public notebook entries]',
            '</entries>',
            '',
            '<matrix_activity>',
            matrixSummaries || '[no Matrix room messages]',
            '</matrix_activity>',
          ].filter(Boolean).join('\n'),
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) {
      return { posted: false, entryCount: yesterdayEntries.length, includedEntryCount: selectedEntries.length, matrixMessageCount: matrixMessages.length, date, skipped: 'empty-model-response' };
    }
    const digestContent = (text as Anthropic.TextBlock).text.trim();
    if (!digestContent) {
      return { posted: false, entryCount: yesterdayEntries.length, includedEntryCount: selectedEntries.length, matrixMessageCount: matrixMessages.length, date, skipped: 'empty-digest' };
    }

    const digestRoomId = await matrix.ensureChannelRoom('digest', 'Daily Digest', 'Daily summary of notebook activity');

    const digestText = `# Daily Digest — ${date}\n\n${digestContent}`;
    await matrix.sendMessage(digestRoomId, digestText);
    console.log(`[Cron] Global digest posted to #digest room (${yesterdayEntries.length} entries, ${matrixMessages.length} Matrix messages)`);

    if (matrixMessages.length === 0) {
      try {
        await maybeSaveDailySummary(storage, date, digestContent, yesterdayEntries);
      } catch (err) {
        console.error('[Cron] Failed to save digest:', err);
      }
    } else {
      console.log('[Cron] Skipping public daily-summary save because digest used Matrix context');
    }

    return {
      posted: true,
      entryCount: yesterdayEntries.length,
      includedEntryCount: selectedEntries.length,
      matrixMessageCount: matrixMessages.length,
      date,
      roomId: digestRoomId,
    };
  } catch (err) {
    console.error('[Cron] Failed to generate digest:', err);
    return {
      posted: false,
      entryCount: yesterdayEntries.length,
      includedEntryCount: selectedEntries.length,
      matrixMessageCount: matrixMessages.length,
      date,
      failed: true,
    };
  }
}

/**
 * Send personalized digests to individual users via Matrix DM.
 * Each user gets a digest curated from their notebook corpus, follow graph,
 * and the prior day's public notebook activity.
 */
function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

function getVerifiedLinkedPlatformUserId(user: User, platform: string): string | null {
  const account = user.linkedAccounts?.find(acc =>
    acc.platform === platform
    && !!acc.platformUserId
    && acc.verified !== false,
  );
  return account?.platformUserId || null;
}

function formatEntryForPrompt(entry: JournalEntry, max = 300): string {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const content = entry.content.trim() || '[no text content]';
  return `[${date}] ${author}: ${content.slice(0, max)}${content.length > max ? '...' : ''}`;
}

async function getMatrixDigestRecipients(storage: Storage, handles?: string[]): Promise<Array<{ user: User; matrixUserId: string }>> {
  const users = handles?.length
    ? (await Promise.all(handles.map(handle => storage.getUser(normalizeHandle(handle))))).filter((u): u is User => !!u)
    : await storage.getAllUsers();

  const seen = new Set<string>();
  const recipients: Array<{ user: User; matrixUserId: string }> = [];
  for (const user of users) {
    if (seen.has(user.handle)) continue;
    seen.add(user.handle);

    const matrixUserId = getVerifiedLinkedPlatformUserId(user, 'matrix');
    if (!matrixUserId) {
      console.log(`[Cron] Skipping Matrix digest for @${user.handle}: no verified linked Matrix account`);
      continue;
    }

    recipients.push({ user, matrixUserId });
  }

  return recipients;
}

export async function sendPersonalizedDigests(
  storage: Storage,
  opts?: { handles?: string[]; force?: boolean },
): Promise<{ sent: number; failed: number; skipped: number }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) {
    console.log('[Cron] Skipping Matrix personalized digests: Matrix platform not connected');
    return { sent, failed, skipped };
  }

  const recipients = await getMatrixDigestRecipients(storage, opts?.handles);
  if (recipients.length === 0) {
    console.log('[Cron] Skipping Matrix personalized digests: no verified linked Matrix recipients');
    return { sent, failed, skipped };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Cron] Skipping Matrix personalized digests: ANTHROPIC_API_KEY is not configured');
    return { sent, failed, skipped: skipped + recipients.length };
  }
  const anthropic = new Anthropic({ apiKey });

  const yesterday = getYesterdayUtcDate();
  const { start: startOfDay, end: endOfDay } = getUtcDayRange(yesterday);
  const allEntries = await storage.getEntriesSince(startOfDay, 500);
  const yesterdayEntries = allEntries.filter(e =>
    e.timestamp >= startOfDay && e.timestamp < endOfDay && isPublicDigestEntry(e)
  );

  for (const { user, matrixUserId } of recipients) {
    const handle = user.handle;
    try {
      const following = user.following || [];
      const followingHandles = new Set(following.map(f => normalizeHandle(f.handle)));
      const recentUserEntries = await storage.getEntriesByHandle(handle, 50);
      const addressedEntries = await storage.getEntriesAddressedTo(handle, user.email, 20)
        .catch(() => [] as JournalEntry[]);
      const publicMatrixMessages = await queryMatrixDigestMessages(matrix, {
        since: startOfDay,
        until: endOfDay,
        limit: 80,
        viewerUserId: matrixUserId,
      });
      const recipientDmMessages = await queryMatrixDigestMessages(matrix, {
        since: startOfDay,
        until: endOfDay,
        limit: 25,
        includeDMs: true,
        onlyDMs: true,
        viewerUserId: matrixUserId,
      });
      const matrixMessages = [
        ...publicMatrixMessages,
        ...recipientDmMessages,
      ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);

      const followedEntries = yesterdayEntries.filter(e =>
        e.handle && e.handle !== handle && followingHandles.has(normalizeHandle(e.handle))
      );
      const discoveryEntries = yesterdayEntries.filter(e =>
        e.handle && e.handle !== handle && !followingHandles.has(normalizeHandle(e.handle))
      );
      const ownYesterdayEntries = yesterdayEntries.filter(e => e.handle === handle);

      const hasDigestContext =
        recentUserEntries.length > 0
        || addressedEntries.length > 0
        || ownYesterdayEntries.length > 0
        || followedEntries.length > 0
        || discoveryEntries.length > 0
        || matrixMessages.length > 0;

      if (!hasDigestContext && !opts?.force) {
        console.log(`[Cron] Skipping Matrix digest for @${handle}: no notebook context available`);
        skipped++;
        continue;
      }

      const personContext = [
        `Recipient: @${handle}${user.displayName ? ` (${user.displayName})` : ''}`,
        user.bio ? `Bio: ${user.bio}` : '',
        following.length > 0
          ? `Follows:\n${following.map(f => `@${f.handle}${f.note ? ` - ${f.note}` : ''}`).join('\n')}`
          : 'Follows: nobody yet',
      ].filter(Boolean).join('\n\n');

      const entrySummaries = [
        recentUserEntries.length > 0
          ? `Recipient's recent notebook corpus:\n${recentUserEntries.slice(0, 25).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        ownYesterdayEntries.length > 0
          ? `Recipient's public entries yesterday:\n${ownYesterdayEntries.slice(0, 5).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        addressedEntries.length > 0
          ? `Entries addressed to recipient:\n${addressedEntries.slice(0, 8).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        followedEntries.length > 0
          ? `From people they follow yesterday:\n${followedEntries.slice(0, 8).map(e => formatEntryForPrompt(e, 300)).join('\n\n')}`
          : '',
        discoveryEntries.length > 0
          ? `Other public notebook activity yesterday:\n${discoveryEntries.slice(0, 8).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        matrixMessages.length > 0
          ? `Matrix conversations yesterday:\n${formatMatrixMessagesForDigestPrompt(matrixMessages, 40)}`
          : '',
      ].filter(Boolean).join('\n\n---\n\n') || 'No public notebook or Matrix activity was available.';

      const response = await anthropic.messages.create({
        model: PERSONALIZED_DIGEST_MODEL,
        max_tokens: 800,
        system: PERSONALIZED_DIGEST_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${personContext}\n\n${yesterdayEntries.length} public entries and ${matrixMessages.length} Matrix messages yesterday (${yesterday}).\n\n${entrySummaries}`,
          },
        ],
      });

      const text = response.content.find(b => b.type === 'text');
      if (!text) {
        console.log(`[Cron] Skipping Matrix digest for @${handle}: Claude returned no text`);
        skipped++;
        continue;
      }
      const digestContent = (text as Anthropic.TextBlock).text;

      await matrix.sendDM(matrixUserId, `📰 Your daily digest\n\n${digestContent}`);
      console.log(`[Cron] Sent personalized digest to @${handle}`);
      sent++;
    } catch (err) {
      console.error(`[Cron] Failed personalized digest for @${handle}:`, err);
      failed++;
    }
  }

  return { sent, failed, skipped };
}

// ── Channel Room Initialization ──────────────────────────────

/**
 * Ensure all existing Router channels have corresponding Matrix rooms.
 * Called on server startup.
 */
export async function initializeChannelRooms(storage: Storage): Promise<void> {
  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) return;

  try {
    const channels = await storage.listChannels();
    for (const channel of channels) {
      try {
        await matrix.ensureChannelRoom(channel.id, channel.name, channel.description);
      } catch (err) {
        console.error(`[Cron] Failed to create room for #${channel.id}:`, err);
      }
    }

    // Always ensure the public firehose room and #digest exist
    await matrix.ensureChannelRoom('bot-noise', 'Bot Noise', 'Router firehose for public notebook entries');
    await matrix.ensureChannelRoom('digest', 'Daily Digest', 'Daily summary of notebook activity');

    console.log(`[Cron] Channel rooms initialized (${channels.length} channels + bot-noise + digest)`);
  } catch (err) {
    console.error('[Cron] Failed to initialize channel rooms:', err);
  }
}

// ── Cron Scheduler ───────────────────────────────────────────

let digestInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cron scheduler.
 */
export function startCronJobs(storage: Storage): void {
  // Initialize channel rooms immediately
  initializeChannelRooms(storage).catch(err => {
    console.error('[Cron] Channel room init failed:', err);
  });

  // Run digest check every hour — only actually generates once per day
  let lastDigestDate = '';
  digestInterval = setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const hour = now.getUTCHours();

    // Generate digest at 8am UTC if we haven't already today
    if (hour === 8 && todayStr !== lastDigestDate) {
      lastDigestDate = todayStr;
      await generateDailyDigest(storage).catch(err => {
        console.error('[Cron] Global digest failed:', err);
      });
      // Send personalized digests to each user via Matrix DM
      await sendPersonalizedDigests(storage).catch(err => {
        console.error('[Cron] Personalized digests failed:', err);
      });
    }
  }, 60 * 60 * 1000); // Check every hour

  console.log('[Cron] Scheduled: daily digest at 8am UTC');
}

export function stopCronJobs(): void {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
  }
}

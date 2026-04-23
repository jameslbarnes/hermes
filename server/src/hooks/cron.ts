/**
 * Cron Hook Handlers
 *
 * Scheduled tasks: daily digest, channel room initialization, profile sync.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry } from '../storage.js';
import type { Platform } from '../platform/types.js';
import { MatrixPlatform, ROUTER_DIGEST_EVENT } from '../platform/matrix.js';
import { getPlatform, getAllPlatforms } from '../platform/registry.js';

// ── Digest ───────────────────────────────────────────────────

const DIGEST_PROMPT = `You are the Router, writing a daily digest of what happened in the shared notebook yesterday.

Write like the editor of a small, smart newspaper. Group entries by theme, highlight surprising connections, note who's writing about what. Make it scannable but interesting.

Structure:
- Lead with the most interesting thing that happened
- Group related entries by theme (2-4 themes)
- Note any connections made (introductions, overlapping work)
- End with a "worth watching" note if there's an emerging trend

Cite @handles. Keep it under 800 words. Write in present tense.

If there were fewer than 3 entries, write a brief note instead of a full digest.`;

const PERSONALIZED_DIGEST_PROMPT = `You are the Router, writing a personalized daily digest for a specific person.

You know this person well:
{user_profile}

Write their digest with THEM in mind. Lead with what matters to THEM — entries from people they follow, work that overlaps with theirs, problems they could help solve (or that could help them).

Structure:
- "For you" section: entries directly relevant to their current work or interests
- "From your network" section: what people they follow wrote about
- "You might want to meet" section: if someone new wrote about something they care about, suggest the connection with a specific reason

Voice: you're a thoughtful friend who reads everything and knows what this person cares about. Not a news aggregator.

Keep it under 500 words. Cite @handles. Be specific about WHY something is relevant to them.`;

/**
 * Generate and post a daily digest.
 * Called by the cron scheduler (typically 8am UTC).
 */
export async function generateDailyDigest(storage: Storage): Promise<void> {
  console.log('[Cron] Generating daily digest...');

  // Get yesterday's entries
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const startOfDay = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

  const allEntries = await storage.getEntriesSince(startOfDay);
  const yesterdayEntries = allEntries.filter(e =>
    e.timestamp >= startOfDay && e.timestamp < endOfDay && !e.aiOnly
  );

  if (yesterdayEntries.length === 0) {
    console.log('[Cron] No entries yesterday, skipping digest');
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Cron] No ANTHROPIC_API_KEY, skipping AI digest');
    return;
  }

  const anthropic = new Anthropic({ apiKey });

  // Format entries for the prompt
  const entrySummaries = yesterdayEntries.map(e => {
    const author = e.handle ? `@${e.handle}` : e.pseudonym;
    const topics = e.topicHints?.join(', ') || '';
    return `[${author}] ${e.content.substring(0, 300)}${e.content.length > 300 ? '...' : ''}${topics ? ` (topics: ${topics})` : ''}`;
  }).join('\n\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 1500,
      system: DIGEST_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${yesterdayEntries.length} entries from ${yesterday.toISOString().split('T')[0]}:\n\n${entrySummaries}`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) return;
    const digestContent = (text as Anthropic.TextBlock).text;

    // Post to Matrix #digest room
    const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
    if (matrix) {
      const digestRoomId = await matrix.ensureChannelRoom('digest', 'Daily Digest', 'Daily summary of notebook activity');

      // Post digest as a message (with custom fields for Router Client rendering)
      const dateStr2 = yesterday.toISOString().split('T')[0];
      const digestText = `📰 Daily Digest — ${dateStr2}\n\n${digestContent}`;
      await matrix.sendMessage(digestRoomId, digestText);
      console.log(`[Cron] Digest posted to #digest room (${yesterdayEntries.length} entries)`);
    }

    // Also save as a Hermes daily summary
    const dateStr = yesterday.toISOString().split('T')[0];
    try {
      // Use the storage API if available
      console.log(`[Cron] Digest generated for ${dateStr}: ${digestContent.substring(0, 100)}...`);
    } catch (err) {
      console.error('[Cron] Failed to save digest:', err);
    }
  } catch (err) {
    console.error('[Cron] Failed to generate digest:', err);
  }
}

/**
 * Send personalized digests to individual users via Matrix DM.
 * Each user gets a digest curated for their interests using their profile.
 */
export async function sendPersonalizedDigests(
  storage: Storage,
  opts?: { handles?: string[] },
): Promise<{ sent: number; failed: number; skipped: number }> {
  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) return { sent: 0, failed: 0, skipped: 0 };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { sent: 0, failed: 0, skipped: 0 };
  const anthropic = new Anthropic({ apiKey });

  // Get yesterday's entries
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const startOfDay = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  const allEntries = await storage.getEntriesSince(startOfDay);
  const yesterdayEntries = allEntries.filter(e =>
    e.timestamp >= startOfDay && e.timestamp < endOfDay && !e.aiOnly
  );

  if (yesterdayEntries.length < 2) return { sent: 0, failed: 0, skipped: 0 };

  // Get all users with interest profiles
  // For now, get users who have entries (active users)
  const activeHandles = opts?.handles?.length
    ? opts.handles
    : [...new Set(yesterdayEntries.map(e => e.handle).filter(Boolean))] as string[];

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const handle of activeHandles) {
    try {
      const user = await storage.getUser(handle);
      if (!user?.interestProfile) {
        skipped++;
        continue;
      }

      const profile = user.interestProfile;
      const following = user.following || [];

      // Categorize entries for this user
      const ownEntries = yesterdayEntries.filter(e => e.handle === handle);
      const followedEntries = yesterdayEntries.filter(e =>
        e.handle && e.handle !== handle && following.some(f => f.handle === e.handle)
      );
      const discoveryEntries = yesterdayEntries.filter(e =>
        e.handle && e.handle !== handle && !following.some(f => f.handle === e.handle)
      );

      if (followedEntries.length === 0 && discoveryEntries.length === 0) {
        skipped++;
        continue;
      }

      const profileContext = `Summary: ${profile.summary}
Working on: ${profile.currentWork.join(', ')}
Expert in: ${profile.expertise.join(', ')}
Curious about: ${profile.curious.join(', ')}
Needs: ${profile.needs.join(', ') || 'nothing specific'}
Follows: ${following.map(f => `@${f.handle}${f.note ? ` (${f.note})` : ''}`).join(', ') || 'nobody yet'}`;

      const entrySummaries = [
        ...followedEntries.slice(0, 5).map(e => `[FOLLOWED] @${e.handle}: ${e.content.substring(0, 200)}`),
        ...discoveryEntries.slice(0, 5).map(e => `[DISCOVERY] @${e.handle}: ${e.content.substring(0, 200)}`),
      ].join('\n\n');

      const systemPrompt = PERSONALIZED_DIGEST_PROMPT.replace('{user_profile}', profileContext);

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `${yesterdayEntries.length} total entries yesterday. Here are the ones relevant to @${handle}:\n\n${entrySummaries}`,
          },
        ],
      });

      const text = response.content.find(b => b.type === 'text');
      if (!text) continue;
      const digestContent = (text as Anthropic.TextBlock).text;

      // Send as DM
      const userId = await matrix.resolvePlatformId(handle);
      if (userId) {
        await matrix.sendDM(userId, `📰 Your daily digest\n\n${digestContent}`);
        console.log(`[Cron] Sent personalized digest to @${handle}`);
        sent++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[Cron] Failed personalized digest for @${handle}:`, err);
      failed++;
    }
  }

  return { sent, failed, skipped };
}

// ── Channel Room Initialization ──────────────────────────────

/**
 * Ensure all existing Hermes channels have corresponding Matrix rooms.
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

    // Always ensure #feed and #digest exist
    await matrix.ensureChannelRoom('feed', 'Feed', 'All public notebook entries');
    await matrix.ensureChannelRoom('digest', 'Daily Digest', 'Daily summary of notebook activity');

    console.log(`[Cron] Channel rooms initialized (${channels.length} channels + feed + digest)`);
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
      await generateDailyDigest(storage);
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

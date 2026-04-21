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
import type { JournalEntry } from '../storage.js';
import { shouldRoute, evaluateEntry, type RecentPost } from '../intelligence/scoring.js';
import { detectSparks, evaluateSpark, getConnectionInfo, executeSpark, type SparkAction } from '../intelligence/sparks.js';
import { RoomBufferManager, type BufferedMessage } from '../intelligence/heat.js';
import { updateInterestProfile, craftIntroduction } from '../intelligence/profiles.js';
import { MatrixPlatform } from '../platform/matrix.js';

// ── State ────────────────────────────────────────────────────

const recentPosts: RecentPost[] = [];
const MAX_RECENT_POSTS = 20;

const roomBuffers = new RoomBufferManager();

function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
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

  const entry = await storage.getEntry(entryId);
  if (!entry) return;

  const authorDisplay = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  console.log(`[Agent] Entry published by ${authorDisplay}: ${entry.content.substring(0, 80)}...`);

  const anthropic = getAnthropic();

  // ── Update interest profile ──────────────────────────────
  if (entry.handle && anthropic) {
    try {
      const user = await storage.getUser(entry.handle);
      if (user) {
        const updatedProfile = await updateInterestProfile(
          entry.handle, entry, user.interestProfile, anthropic,
        );
        await storage.updateUser(entry.handle, { interestProfile: updatedProfile });
        console.log(`[Agent] Updated profile for ${authorDisplay}: ${updatedProfile.summary.substring(0, 80)}...`);
      }
    } catch (err) {
      console.error('[Agent] Profile update failed:', err);
    }
  }

  // ── Routing: should this entry be surfaced on platforms? ──
  let evaluationKeywords: string[] | undefined;

  if (shouldRoute(entry)) {
    const evaluation = await evaluateEntry(entry, anthropic, storage, recentPosts);
    evaluationKeywords = evaluation.keywords;

    if (evaluation.route) {
      // Determine which channels this entry targets
      const channelDests = (entry.to || []).filter(d => d.startsWith('#')).map(d => d.slice(1));

      for (const platform of platforms) {
        try {
          if (platform instanceof MatrixPlatform) {
            // Post as rich custom events to Matrix
            if (channelDests.length > 0) {
              // Route to specific channel rooms
              for (const channelId of channelDests) {
                const roomId = await platform.ensureChannelRoom(channelId, channelId);
                await platform.postEntry(roomId, entry, evaluation.hook);
                console.log(`[Agent] Posted entry to #${channelId} on Matrix`);
              }
            }
            // Always also post to #feed
            const feedRoomId = await platform.ensureChannelRoom('feed', 'Feed', 'All public notebook entries');
            await platform.postEntry(feedRoomId, entry, evaluation.hook);
            console.log(`[Agent] Posted entry to #feed on Matrix`);
          } else {
            // Other platforms: send as formatted text
            const content = evaluation.hook || entry.content;
            console.log(`[Agent] Routing to ${platform.name}: ${content.substring(0, 80)}...`);
          }

          recentPosts.push({
            author: authorDisplay,
            contentSnippet: entry.content.slice(0, 200),
            hook: evaluation.hook,
          });
          if (recentPosts.length > MAX_RECENT_POSTS) recentPosts.shift();
        } catch (err) {
          console.error(`[Agent] Failed to route to ${platform.name}:`, err);
        }
      }
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
  const { event } = ctx;
  const author = event.data.author_handle || event.data.author_pseudonym;
  console.log(`[Agent] Entry staged by ${author}: ${event.data.entry_id}`);
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
  const { platform: platformName, room_id, text, sender_handle, message_id } = event.data;

  if (!text || !room_id) return;

  const platform = platforms.find(p => p.name === platformName);
  if (!platform) return;

  console.log(`[Agent] Mentioned on ${platformName} by ${sender_handle || 'unknown'}: ${text.substring(0, 80)}...`);

  // Extract the query (remove @mentions)
  const query = text.replace(/@\w+/g, '').trim();
  if (query.length < 3) {
    await platform.sendMessage(room_id, "What would you like to know? I can search the notebook for entries, find connections between people, or help you explore topics.", {
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
  candidate: import('../intelligence/sparks.js').SparkCandidate,
  sourceEntry: JournalEntry,
  platforms: import('../platform/types.js').Platform[],
  storage?: import('../storage.js').Storage,
): Promise<void> {
  if (action.action === 'skip') return;

  const matrixPlatform = platforms.find(p => p instanceof MatrixPlatform) as MatrixPlatform | undefined;
  const anthropic = getAnthropic();

  // Try to craft a warm introduction using interest profiles
  let warmMessage = action.message;
  if (anthropic && storage && (action.action === 'introduce' || action.action === 'suggest')) {
    try {
      const sourceUser = await storage.getUser(action.sourceHandle);
      const targetUser = await storage.getUser(action.targetHandle);
      if (sourceUser?.interestProfile && targetUser?.interestProfile) {
        const crafted = await craftIntroduction(
          sourceUser.interestProfile, action.sourceHandle,
          targetUser.interestProfile, action.targetHandle,
          sourceEntry, anthropic,
        );
        if (crafted) {
          warmMessage = crafted;
          console.log(`[Agent] Warm introduction: ${crafted.substring(0, 100)}...`);
        }
      }
    } catch (err) {
      console.error('[Agent] Failed to craft warm introduction:', err);
    }
  }

  if (action.action === 'introduce' && matrixPlatform) {
    const room = await matrixPlatform.createRoom(
      `@${action.sourceHandle} ↔ @${action.targetHandle}`,
      {
        type: 'group',
        invite: [action.sourceHandle, action.targetHandle],
        topic: action.reason,
        encrypted: true,
      },
    );

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

    // Post the warm introduction message
    if (warmMessage) {
      await matrixPlatform.sendMessage(room.id, warmMessage);
    }

    console.log(`[Agent] Introduction room created: ${room.id}`);
    return;
  }

  // For suggest/nudge, use the warm message if available
  if (warmMessage) {
    action = { ...action, message: warmMessage };
  }
  await executeSpark(action, platforms, 'router');
}

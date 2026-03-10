/**
 * Telegram Bot for Hermes — main wiring.
 *
 * Posts published entries to a Telegram channel, responds to @mentions,
 * proactively interjects in group chat, handles follow-ups on its own
 * messages, and writes summaries back to Hermes.
 *
 * State (surfaced entries, recent posts, rate limits) persists across
 * restarts via a JSON file on disk.
 */

import { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry } from '../storage.js';
import { derivePseudonym, hashSecretKey, generateSecretKey } from '../identity.js';
import type { TelegramConfig, BotContext, PostedEntry } from './types.js';
import { MessageBuffer } from './buffer.js';
import { RateLimiter } from './rate-limiter.js';
import {
  filterEntry,
  formatEntryForTelegram,
  escapeMarkdownV2,
  formatCuratedPost,
  trackPostedEntry,
  extractJson,
} from './filter.js';

import { handleMention } from './mention-handler.js';
import { handleFollowup, isDirectedAtBot } from './followup-handler.js';
import { BATCH_PICK_PROMPT } from './prompts.js';
import { Interjector } from './interjector.js';
import { Writer } from './writer.js';
import { loadState, startStateSaver, type BotState } from './state.js';

// Re-export public types and functions for the facade
export type { TelegramConfig } from './types.js';
export { shouldPostToTelegram, formatEntryForTelegram } from './filter.js';

let bot: Telegraf | null = null;
let postToChannel: ((entry: JournalEntry) => Promise<void>) | null = null;

/**
 * Post a single entry to the Telegram channel.
 * Called from the onPublish callback in http.ts.
 */
export async function postToTelegram(entry: JournalEntry): Promise<void> {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  console.log(`[Telegram] postToTelegram called for entry ${entry.id} by ${author}`);
  if (!postToChannel) {
    console.log('[Telegram] No postToChannel function set — bot not initialized?');
    return;
  }
  await postToChannel(entry);
}

/**
 * Ensure the bot has a Hermes identity (user record + handle).
 */
async function ensureBotIdentity(
  storage: Storage,
  secretKey: string,
  handle: string,
): Promise<{ pseudonym: string; handle: string }> {
  const pseudonym = derivePseudonym(secretKey);
  const keyHash = hashSecretKey(secretKey);

  const existing = await storage.getUserByKeyHash(keyHash);
  if (existing) {
    return { pseudonym, handle: existing.handle };
  }

  const available = await storage.isHandleAvailable(handle);
  if (!available) {
    const fallback = `hermes_bot_${keyHash.slice(0, 6)}`;
    console.log(`[Telegram] Handle @${handle} taken, using @${fallback}`);
    handle = fallback;
  }

  try {
    await storage.createUser({
      handle,
      secretKeyHash: keyHash,
      displayName: 'Hermes Bot',
      bio: 'I relay interesting conversations from Telegram to the notebook.',
      legacyPseudonym: pseudonym,
    });
    console.log(`[Telegram] Created bot identity: @${handle} (${pseudonym})`);
  } catch (err: any) {
    if (!err.message?.includes('already exists')) {
      console.error('[Telegram] Failed to create bot identity:', err);
    }
  }

  return { pseudonym, handle };
}

/**
 * Start the Telegram bot. Returns a cleanup function.
 */
export function startTelegramBot(
  storage: Storage,
  config: TelegramConfig,
): () => void {
  bot = new Telegraf(config.botToken);

  const postMode = config.postMode || 'score';
  const anthropic = config.anthropicApiKey
    ? new Anthropic({ apiKey: config.anthropicApiKey })
    : undefined;

  // --- Load persisted state ---
  const state = loadState();
  const recentlyPosted: PostedEntry[] = state.recentlyPosted;
  const channelPostTimestamps: number[] = state.channelPostTimestamps;

  // Prune old channel timestamps (>24h)
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  while (channelPostTimestamps.length > 0 && channelPostTimestamps[0] < dayAgo) {
    channelPostTimestamps.shift();
  }

  // --- Session debounce queue ---
  // Entries are held per-pseudonym for SESSION_DEBOUNCE_MS.
  // If more arrive from the same author, the timer resets.
  // When the timer fires: 1 entry → post raw, multiple → pick best or summarize.
  const SESSION_DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes
  const sessionQueues = new Map<string, { entries: JournalEntry[]; timer: ReturnType<typeof setTimeout> }>();

  /** Actually send a message to the group/channel and track it. */
  async function sendEntry(entry: JournalEntry) {
    if (!bot) return;
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
    const message = formatEntryForTelegram(entry, config.baseUrl);
    const target = config.groupChatId || config.channelId;
    console.log(`[Telegram] Posting entry ${entry.id} by ${author} to ${target}`);
    try {
      const result = await bot.telegram.sendMessage(target, message, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      console.log(`[Telegram] Posted successfully, message_id=${result.message_id}`);
      const mainGroup = groups.get(target);
      if (mainGroup) {
        mainGroup.buffer.push({
          senderName: 'Hermes',
          text: `${author}: ${entry.content.slice(0, 500)}`,
          timestamp: Date.now(),
          messageId: result.message_id,
        });
        mainGroup.botMessageIds.add(result.message_id);
      }
      const updated = trackPostedEntry(recentlyPosted, entry);
      recentlyPosted.length = 0;
      recentlyPosted.push(...updated);
      channelPostTimestamps.push(Date.now());
    } catch (err) {
      console.error('[Telegram] Failed to post entry:', err);
      try {
        const plainMessage = `${author}\n\n${entry.content.slice(0, 3500)}\n\n${config.baseUrl}/#entry-${entry.id}`;
        const fallbackResult = await bot.telegram.sendMessage(target, plainMessage);
        const fallbackGroup = groups.get(target);
        if (fallbackGroup) {
          fallbackGroup.buffer.push({
            senderName: 'Hermes',
            text: `${author}: ${entry.content.slice(0, 500)}`,
            timestamp: Date.now(),
            messageId: fallbackResult.message_id,
          });
          fallbackGroup.botMessageIds.add(fallbackResult.message_id);
        }
        channelPostTimestamps.push(Date.now());
      } catch (retryErr) {
        console.error('[Telegram] Plain text fallback also failed:', retryErr);
      }
    }
  }

  /** Send a plain-text summary message to the group/channel. */
  async function sendSummary(author: string, summaryText: string, permalink: string) {
    if (!bot) return;
    const target = config.groupChatId || config.channelId;
    const link = `[Permalink](${escapeMarkdownV2(permalink)})`;
    const message = `*${escapeMarkdownV2(author)}*\n\n${escapeMarkdownV2(summaryText)}\n\n${link}`;
    try {
      const result = await bot.telegram.sendMessage(target, message, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      const summaryGroup = groups.get(target);
      if (summaryGroup) {
        summaryGroup.buffer.push({
          senderName: 'Hermes',
          text: `${author}: ${summaryText.slice(0, 500)}`,
          timestamp: Date.now(),
          messageId: result.message_id,
        });
        summaryGroup.botMessageIds.add(result.message_id);
      }
      channelPostTimestamps.push(Date.now());
    } catch (err) {
      console.error('[Telegram] Failed to post summary:', err);
    }
  }

  /** Flush a session queue: pick best entry or summarize, then post. */
  async function flushSessionQueue(pseudonym: string) {
    const queue = sessionQueues.get(pseudonym);
    if (!queue || queue.entries.length === 0) {
      sessionQueues.delete(pseudonym);
      return;
    }
    const entries = queue.entries;
    sessionQueues.delete(pseudonym);

    console.log(`[Telegram/Debounce] Flushing ${entries.length} entries for ${pseudonym}`);

    if (entries.length === 1) {
      await sendEntry(entries[0]);
      return;
    }

    // Multiple entries — use Haiku to pick the best or summarize
    if (!anthropic) {
      // No API key, just post the first one
      await sendEntry(entries[0]);
      return;
    }

    try {
      const author = entries[0].handle ? `@${entries[0].handle}` : entries[0].pseudonym;
      const entriesText = entries
        .map((e, i) => `[${i}] ${e.content.slice(0, 500)}`)
        .join('\n\n');

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: BATCH_PICK_PROMPT,
        messages: [{ role: 'user', content: `Author: ${author}\n\nEntries:\n${entriesText}` }],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock) {
        await sendEntry(entries[0]);
        return;
      }

      const raw = (textBlock as Anthropic.TextBlock).text;
      console.log(`[Telegram/Debounce] Haiku response: ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(extractJson(raw));

      if (parsed.mode === 'pick' && typeof parsed.index === 'number') {
        const idx = Math.max(0, Math.min(parsed.index, entries.length - 1));
        console.log(`[Telegram/Debounce] Picked entry ${idx} of ${entries.length}`);
        await sendEntry(entries[idx]);
      } else if (parsed.mode === 'summary' && parsed.text) {
        console.log(`[Telegram/Debounce] Using summary for ${entries.length} entries`);
        const permalink = `${config.baseUrl}/#entry-${entries[0].id}`;
        await sendSummary(author, parsed.text, permalink);
      } else {
        await sendEntry(entries[0]);
      }
    } catch (err) {
      console.error('[Telegram/Debounce] Failed to pick/summarize:', err);
      await sendEntry(entries[0]);
    }
  }

  // --- Channel posting (with session debounce) ---
  postToChannel = async (entry: JournalEntry) => {
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;

    const filterResult = await filterEntry(
      entry,
      recentlyPosted,
      postMode,
      anthropic,
      storage,
      channelPostTimestamps,
    );
    if (!filterResult.post) {
      console.log(
        `[Telegram] Filtered out entry ${entry.id} by ${author} (mode=${postMode})`,
      );
      return;
    }

    if (!bot) {
      console.log('[Telegram] Bot not initialized, skipping');
      return;
    }

    // Queue the entry with a debounce timer per pseudonym
    const key = entry.pseudonym;
    const existing = sessionQueues.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.entries.push(entry);
      console.log(`[Telegram/Debounce] Queued entry ${entry.id} for ${key} (${existing.entries.length} in batch)`);
      existing.timer = setTimeout(() => flushSessionQueue(key), SESSION_DEBOUNCE_MS);
    } else {
      console.log(`[Telegram/Debounce] First entry ${entry.id} for ${key}, starting 30m timer`);
      const timer = setTimeout(() => flushSessionQueue(key), SESSION_DEBOUNCE_MS);
      sessionQueues.set(key, { entries: [entry], timer });
    }
  };

  // --- Scheduled summaries for channel chats ---
  const channelChatMapping = config.channelChatMapping || {};
  const scheduledTimers: ReturnType<typeof setTimeout>[] = [];

  async function postScheduledSummary(channelId: string, chatId: string, type: 'morning' | 'evening') {
    if (!bot || !anthropic) return;
    try {
      // Get entries from the last 24h for this channel
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const allEntries = await storage.getChannelEntries(channelId, 50);
      const recentEntries = allEntries.filter(e => e.timestamp > since);

      if (recentEntries.length === 0) {
        console.log(`[Telegram/Schedule] No recent entries for #${channelId}, skipping ${type} summary`);
        return;
      }

      const entriesText = recentEntries
        .map(e => {
          const author = e.handle ? `@${e.handle}` : e.pseudonym;
          return `${author}: ${e.content.slice(0, 500)}`;
        })
        .join('\n\n---\n\n');

      const systemPrompt = type === 'morning'
        ? `You are a hackathon coordinator bot. Write a concise morning progress digest for the team's Telegram group. Summarize what happened overnight — who's building what, key progress, any blockers mentioned. Keep it energizing and under 200 words. Use plain text, no markdown. Start with a brief greeting like "Good morning, hackers!" or similar.`
        : `You are a hackathon coordinator bot. Write a brief evening shoutout for the team's Telegram group. Highlight one team or person who made exceptional progress today — be specific about what they did. Keep it celebratory and under 150 words. Use plain text, no markdown. Start with something like "Evening shoutout!" or similar.`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Here are today's updates from #${channelId}:\n\n${entriesText}` }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) return;

      const summary = (textBlock as Anthropic.TextBlock).text;
      console.log(`[Telegram/Schedule] Posting ${type} summary to ${chatId} for #${channelId}`);
      await bot.telegram.sendMessage(chatId, summary);
    } catch (err) {
      console.error(`[Telegram/Schedule] Failed to post ${type} summary:`, err);
    }
  }

  function scheduleDaily(hour: number, minute: number, callback: () => void) {
    function scheduleNext() {
      const now = new Date();
      const target = new Date(now);
      target.setUTCHours(hour, minute, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      const delay = target.getTime() - now.getTime();
      console.log(`[Telegram/Schedule] Next run in ${Math.round(delay / 1000 / 60)} minutes (${target.toISOString()})`);
      const timer = setTimeout(() => {
        callback();
        scheduleNext();
      }, delay);
      scheduledTimers.push(timer);
    }
    scheduleNext();
  }

  // Schedule morning digest at 13:00 UTC (9am ET) and evening shoutout at 00:00 UTC (8pm ET)
  for (const [channelId, chatId] of Object.entries(channelChatMapping)) {
    scheduleDaily(13, 0, () => postScheduledSummary(channelId, chatId, 'morning'));
    scheduleDaily(0, 0, () => postScheduledSummary(channelId, chatId, 'evening'));
    console.log(`[Telegram/Schedule] Scheduled morning (13:00 UTC) and evening (00:00 UTC) summaries for #${channelId} → ${chatId}`);
  }

  // --- Bot identity (for proactive features) ---
  const botSecretKey = config.botSecretKey || generateSecretKey();
  const botHandle = config.botHandle || 'hermes_bot';

  // --- Multi-group proactive features ---
  // Each watched group gets its own buffer, interjector, writer, and message tracking.
  interface GroupState {
    chatId: string;
    buffer: MessageBuffer;
    interjector: Interjector | null;
    writer: Writer | null;
    botMessageIds: Set<number>;
  }
  const groups = new Map<string, GroupState>();
  let interjectionTimer: ReturnType<typeof setInterval> | null = null;

  // Collect all group chat IDs: main group + channel-mapped groups
  const allGroupChatIds = new Set<string>();
  if (config.groupChatId) allGroupChatIds.add(String(config.groupChatId));
  for (const chatId of Object.values(channelChatMapping)) {
    allGroupChatIds.add(String(chatId));
  }

  if (allGroupChatIds.size > 0 && config.anthropicApiKey) {
    ensureBotIdentity(storage, botSecretKey, botHandle).then((identity) => {
      // Create per-group state
      for (const groupChatId of allGroupChatIds) {
        const groupBuffer = new MessageBuffer();
        const groupBotMessageIds = new Set<number>();

        const groupCtx: BotContext = {
          config,
          storage,
          sendToChannel: async (text: string) => {
            if (!bot) return;
            await bot.telegram.sendMessage(config.channelId, text, {
              parse_mode: 'MarkdownV2',
              link_preview_options: { is_disabled: true },
            });
          },
          sendToGroup: async (text: string, replyToMessageId?: number) => {
            if (!bot) return;
            const sent = await bot.telegram.sendMessage(groupChatId, text, {
              ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
            });
            groupBotMessageIds.add(sent.message_id);
          },
          botPseudonym: identity.pseudonym,
          botHandle: identity.handle,
        };

        const rateLimiter = new RateLimiter({
          maxPerHour: config.maxPerHour || 6,
          cooldownMs: config.cooldownMs || 5 * 60 * 1000,
        });

        // Only restore state for the original main group
        if (groupChatId === String(config.groupChatId)) {
          for (const ts of state.proactivePostTimestamps) {
            rateLimiter.record(ts);
          }
        }

        const groupInterjector = new Interjector(
          groupCtx,
          groupBuffer,
          rateLimiter,
          config.anthropicApiKey!,
          groupChatId === String(config.groupChatId) ? state.surfacedEntryIds : [],
          groupChatId === String(config.groupChatId) ? state.surfacedSummaries : [],
        );
        const groupWriter = new Writer(groupCtx, groupBuffer, config.anthropicApiKey!,
          groupChatId === String(config.groupChatId) ? state.lastWritebackTime : Date.now(),
        );

        groups.set(groupChatId, {
          chatId: groupChatId,
          buffer: groupBuffer,
          interjector: groupInterjector,
          writer: groupWriter,
          botMessageIds: groupBotMessageIds,
        });

        console.log(`[Telegram] Proactive features enabled for group ${groupChatId} as @${identity.handle}`);
      }

      // Timer-based checks (every 15 min) — iterate all groups
      interjectionTimer = setInterval(async () => {
        for (const [gid, group] of groups) {
          if (group.interjector && group.buffer.size > 0) {
            try {
              await group.interjector.tryInterject();
            } catch (err) {
              console.error(`[Telegram/Interjector] Timer check failed for group ${gid}:`, err);
            }
          }
          if (group.writer) {
            try {
              await group.writer.tryWriteBack();
            } catch (err) {
              console.error(`[Telegram/Writer] Timer check failed for group ${gid}:`, err);
            }
          }
        }
      }, 15 * 60 * 1000);
    }).catch((err) => {
      console.error('[Telegram] Failed to set up bot identity:', err);
    });
  }

  // --- State persistence ---
  // Persist state from the main group (backward compatible)
  const mainGroupId = config.groupChatId ? String(config.groupChatId) : null;
  const stopStateSaver = startStateSaver(() => {
    const mainGroup = mainGroupId ? groups.get(mainGroupId) : null;
    const currentState: BotState = {
      surfacedEntryIds: mainGroup?.interjector?.getSurfacedEntryIds() || state.surfacedEntryIds,
      surfacedSummaries: mainGroup?.interjector?.getSurfacedSummaries() || state.surfacedSummaries,
      recentlyPosted,
      channelPostTimestamps,
      proactivePostTimestamps: [],
      lastWritebackTime: mainGroup?.writer?.getLastWritebackTime() || state.lastWritebackTime,
    };
    return currentState;
  });

  // --- Message handlers ---

  /** Send a reply, falling back to a plain message if the original message is gone. */
  async function safeReply(ctx: any, text: string, replyToMessageId?: number) {
    try {
      return await ctx.reply(text, {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      });
    } catch (err: any) {
      if (err?.response?.error_code === 400 && err?.response?.description?.includes('message to be replied not found')) {
        // Original message was deleted (e.g. during deploy restart) — send without reply
        return await ctx.reply(text);
      }
      throw err;
    }
  }

  if (config.anthropicApiKey) {
    const mentionAnthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    bot.on('message', async (ctx) => {
      const text = 'text' in ctx.message ? ctx.message.text : null;
      if (!text) return;

      const chatType = ctx.chat?.type;
      const chatId = ctx.chat?.id;
      const msg = ctx.message as any;

      console.log(
        `[Telegram] Message received in ${chatType} (chat_id: ${chatId}): "${text.slice(0, 100)}"`,
      );

      // Find the group state for this chat (if it's a watched group)
      const group = chatId ? groups.get(String(chatId)) : null;
      if (group) {
        const senderName =
          msg.from?.first_name ||
          msg.from?.username ||
          'Unknown';
        group.buffer.push({
          senderName,
          text,
          timestamp: Date.now(),
          messageId: msg.message_id,
        });

        // Check for reply to one of the bot's own messages (follow-up)
        const replyToId = msg.reply_to_message?.message_id;
        if (replyToId && group.botMessageIds.has(replyToId)) {
          console.log(`[Telegram] Follow-up detected on bot message ${replyToId} in group ${chatId}`);
          const chatContext = group.buffer.formatForContext(50);
          handleFollowup(
            {
              text,
              chatContext,
              reply: async (answer: string) => {
                const sent = await safeReply(ctx, answer, msg.message_id);
                group.botMessageIds.add(sent.message_id);
                group.buffer.push({
                  senderName: 'Hermes',
                  text: answer.slice(0, 500),
                  timestamp: Date.now(),
                  messageId: sent.message_id,
                });
              },
            },
            storage,
            mentionAnthropic,
          ).catch((err) => {
            console.error('[Telegram/Followup] Failed:', err);
          });
          return;
        }

        // Implicit conversation: if the bot spoke recently (within last 5 messages)
        const recentMsgs = group.buffer.recent(5);
        const botSpokeRecently = recentMsgs.some(
          (m) => m.senderName === 'Hermes' && m.timestamp > Date.now() - 10 * 60 * 1000,
        );
        if (botSpokeRecently) {
          const chatContext = group.buffer.formatForContext(50);
          const directed = await isDirectedAtBot(chatContext, mentionAnthropic);
          if (directed) {
            console.log(`[Telegram] Implicit conversation in group ${chatId}`);
            handleFollowup(
              {
                text,
                chatContext,
                reply: async (answer: string) => {
                  const sent = await safeReply(ctx, answer, msg.message_id);
                  group.botMessageIds.add(sent.message_id);
                  group.buffer.push({
                    senderName: 'Hermes',
                    text: answer.slice(0, 500),
                    timestamp: Date.now(),
                    messageId: sent.message_id,
                  });
                },
              },
              storage,
              mentionAnthropic,
            ).catch((err) => {
              console.error('[Telegram/Followup] Failed:', err);
            });
            return;
          }
        }

        // Check if interjector should evaluate
        if (group.interjector && group.interjector.shouldEvaluate()) {
          group.interjector.tryInterject().catch((err) => {
            console.error(`[Telegram/Interjector] Eval failed for group ${chatId}:`, err);
          });
        }
      }

      // Check if the bot is @mentioned (works in any chat, not just watched groups)
      const botInfo = await bot!.telegram.getMe();
      const botUsername = botInfo.username;
      const isMentioned =
        text.includes(`@${botUsername}`) ||
        msg.reply_to_message?.from?.id === botInfo.id;

      console.log(`[Telegram] Bot username: @${botUsername}, mentioned: ${isMentioned}`);
      if (!isMentioned) return;

      const query = text.replace(`@${botUsername}`, '').trim();
      console.log(`[Telegram] Query extracted: "${query}"`);

      const chatContext = group && group.buffer.size > 0 ? group.buffer.formatForContext(50) : undefined;
      await handleMention(
        {
          query,
          reply: async (answer: string) => {
            const sent = await safeReply(ctx, answer, msg.message_id);
            if (group) {
              group.botMessageIds.add(sent.message_id);
              group.buffer.push({
                senderName: 'Hermes',
                text: answer.slice(0, 500),
                timestamp: Date.now(),
                messageId: sent.message_id,
              });
            }
          },
          chatContext,
          botUsername: botUsername || undefined,
        },
        storage,
        mentionAnthropic,
      );
    });
  }

  // Launch the bot (long polling)
  bot.launch().catch((err) => {
    console.error('[Telegram] Bot failed to start:', err);
  });

  console.log(
    `[Telegram] Bot started (channel: ${config.channelId}, anthropic: ${config.anthropicApiKey ? 'yes' : 'no'}, group: ${config.groupChatId || 'none'}, mode: ${postMode})`,
  );

  // Return cleanup function
  return () => {
    if (interjectionTimer) clearInterval(interjectionTimer);
    scheduledTimers.forEach(t => clearTimeout(t));
    // Flush all pending session queues immediately on shutdown
    for (const [key, queue] of sessionQueues) {
      clearTimeout(queue.timer);
      flushSessionQueue(key).catch(() => {});
    }
    stopStateSaver(); // Final save
    bot?.stop('shutdown');
    bot = null;
    postToChannel = null;
  };
}

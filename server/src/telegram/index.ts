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
      buffer.push({
        senderName: 'Hermes',
        text: `${author}: ${entry.content.slice(0, 500)}`,
        timestamp: Date.now(),
        messageId: result.message_id,
      });
      botMessageIds.add(result.message_id);
      const updated = trackPostedEntry(recentlyPosted, entry);
      recentlyPosted.length = 0;
      recentlyPosted.push(...updated);
      channelPostTimestamps.push(Date.now());
    } catch (err) {
      console.error('[Telegram] Failed to post entry:', err);
      try {
        const plainMessage = `${author}\n\n${entry.content.slice(0, 3500)}\n\n${config.baseUrl}/#entry-${entry.id}`;
        const fallbackResult = await bot.telegram.sendMessage(target, plainMessage);
        buffer.push({
          senderName: 'Hermes',
          text: `${author}: ${entry.content.slice(0, 500)}`,
          timestamp: Date.now(),
          messageId: fallbackResult.message_id,
        });
        botMessageIds.add(fallbackResult.message_id);
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
      buffer.push({
        senderName: 'Hermes',
        text: `${author}: ${summaryText.slice(0, 500)}`,
        timestamp: Date.now(),
        messageId: result.message_id,
      });
      botMessageIds.add(result.message_id);
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

  // --- Bot identity (for proactive features) ---
  const botSecretKey = config.botSecretKey || generateSecretKey();
  const botHandle = config.botHandle || 'hermes_bot';

  // --- Proactive features (group chat) ---
  let interjector: Interjector | null = null;
  let writer: Writer | null = null;
  const buffer = new MessageBuffer();
  let interjectionTimer: ReturnType<typeof setInterval> | null = null;
  /** Message IDs the bot has sent, for follow-up detection. */
  const botMessageIds = new Set<number>();

  if (config.groupChatId && config.anthropicApiKey) {
    ensureBotIdentity(storage, botSecretKey, botHandle).then((identity) => {
      const botCtx: BotContext = {
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
          if (!bot || !config.groupChatId) return;
          const sent = await bot.telegram.sendMessage(config.groupChatId, text, {
            ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
          });
          botMessageIds.add(sent.message_id);
        },
        botPseudonym: identity.pseudonym,
        botHandle: identity.handle,
      };

      const rateLimiter = new RateLimiter({
        maxPerHour: config.maxPerHour || 6,
        cooldownMs: config.cooldownMs || 5 * 60 * 1000,
      });

      // Restore proactive rate limiter state
      for (const ts of state.proactivePostTimestamps) {
        rateLimiter.record(ts);
      }

      interjector = new Interjector(
        botCtx,
        buffer,
        rateLimiter,
        config.anthropicApiKey!,
        state.surfacedEntryIds,
        state.surfacedSummaries,
      );
      writer = new Writer(botCtx, buffer, config.anthropicApiKey!, state.lastWritebackTime);

      // Timer-based checks (every 15 min)
      interjectionTimer = setInterval(async () => {
        if (interjector && buffer.size > 0) {
          try {
            await interjector.tryInterject();
          } catch (err) {
            console.error('[Telegram/Interjector] Timer check failed:', err);
          }
        }
        if (writer) {
          try {
            await writer.tryWriteBack();
          } catch (err) {
            console.error('[Telegram/Writer] Timer check failed:', err);
          }
        }
      }, 15 * 60 * 1000);

      console.log(
        `[Telegram] Proactive features enabled for group ${config.groupChatId} as @${identity.handle}`,
      );
    }).catch((err) => {
      console.error('[Telegram] Failed to set up bot identity:', err);
    });
  }

  // --- State persistence ---
  const stopStateSaver = startStateSaver(() => {
    const currentState: BotState = {
      surfacedEntryIds: interjector?.getSurfacedEntryIds() || state.surfacedEntryIds,
      surfacedSummaries: interjector?.getSurfacedSummaries() || state.surfacedSummaries,
      recentlyPosted,
      channelPostTimestamps,
      proactivePostTimestamps: [], // Rate limiter handles its own pruning
      lastWritebackTime: writer?.getLastWritebackTime() || state.lastWritebackTime,
    };
    return currentState;
  });

  // --- Message handlers ---

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

      // Buffer group messages for interjection context
      const isGroupChat = config.groupChatId && String(chatId) === String(config.groupChatId);
      if (isGroupChat) {
        const senderName =
          msg.from?.first_name ||
          msg.from?.username ||
          'Unknown';
        buffer.push({
          senderName,
          text,
          timestamp: Date.now(),
          messageId: msg.message_id,
        });

        // Check for reply to one of the bot's own messages (follow-up)
        const replyToId = msg.reply_to_message?.message_id;
        if (replyToId && botMessageIds.has(replyToId)) {
          console.log(`[Telegram] Follow-up detected on bot message ${replyToId}`);
          const chatContext = buffer.formatForContext(50);
          handleFollowup(
            {
              text,
              chatContext,
              reply: async (answer: string) => {
                const sent = await ctx.reply(answer, {
                  reply_parameters: { message_id: msg.message_id },
                });
                botMessageIds.add(sent.message_id);
                buffer.push({
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

        // Implicit conversation: if the bot spoke recently (within last 5 messages),
        // use a cheap Haiku gate to check if the message is directed at the bot
        const recentMsgs = buffer.recent(5);
        const botSpokeRecently = recentMsgs.some(
          (m) => m.senderName === 'Hermes' && m.timestamp > Date.now() - 10 * 60 * 1000,
        );
        if (botSpokeRecently) {
          const chatContext = buffer.formatForContext(50);
          const directed = await isDirectedAtBot(chatContext, mentionAnthropic);
          if (directed) {
            console.log(`[Telegram] Implicit conversation: message directed at bot`);
            handleFollowup(
              {
                text,
                chatContext,
                reply: async (answer: string) => {
                  const sent = await ctx.reply(answer, {
                    reply_parameters: { message_id: msg.message_id },
                  });
                  botMessageIds.add(sent.message_id);
                  buffer.push({
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
          console.log(`[Telegram] Bot spoke recently but message not directed at bot`);
        }

        // Check if interjector should evaluate
        if (interjector && interjector.shouldEvaluate()) {
          interjector.tryInterject().catch((err) => {
            console.error('[Telegram/Interjector] Eval failed:', err);
          });
        }
      }

      // Check if the bot is @mentioned
      const botInfo = await bot!.telegram.getMe();
      const botUsername = botInfo.username;
      const isMentioned =
        text.includes(`@${botUsername}`) ||
        msg.reply_to_message?.from?.id === botInfo.id;

      console.log(`[Telegram] Bot username: @${botUsername}, mentioned: ${isMentioned}`);
      if (!isMentioned) return;

      const query = text.replace(`@${botUsername}`, '').trim();
      console.log(`[Telegram] Query extracted: "${query}"`);

      const chatContext = buffer.size > 0 ? buffer.formatForContext(50) : undefined;
      await handleMention(
        {
          query,
          reply: async (answer: string) => {
            const sent = await ctx.reply(answer, {
              reply_parameters: { message_id: msg.message_id },
            });
            botMessageIds.add(sent.message_id);
            buffer.push({
              senderName: 'Hermes',
              text: answer.slice(0, 500),
              timestamp: Date.now(),
              messageId: sent.message_id,
            });
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

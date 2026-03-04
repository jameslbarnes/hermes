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
  formatCuratedPost,
  trackPostedEntry,
} from './filter.js';
import { handleMention } from './mention-handler.js';
import { handleFollowup } from './followup-handler.js';
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

  // --- Channel posting ---
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

    // In score mode with a hook, post the curated version.
    // Otherwise fall back to raw content.
    const message = filterResult.hook
      ? formatCuratedPost(entry, filterResult.hook, config.baseUrl)
      : formatEntryForTelegram(entry, config.baseUrl);

    // Post to group if available, otherwise channel
    const target = config.groupChatId || config.channelId;
    const postType = filterResult.hook ? 'curated' : 'raw';
    console.log(
      `[Telegram] Posting ${postType} entry ${entry.id} by ${author} to ${target} (${message.length} chars)`,
    );
    try {
      const result = await bot.telegram.sendMessage(target, message, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      console.log(`[Telegram] Posted successfully, message_id=${result.message_id}`);
      // Track for dedup + curation context + rate limiting
      const updated = trackPostedEntry(recentlyPosted, entry, filterResult.hook);
      recentlyPosted.length = 0;
      recentlyPosted.push(...updated);
      channelPostTimestamps.push(Date.now());
    } catch (err) {
      console.error('[Telegram] Failed to post entry:', err);
      try {
        const hook = filterResult.hook;
        const plainMessage = hook
          ? `${hook}\n\n\u2014 ${author} | ${config.baseUrl}/#entry-${entry.id}`
          : `${author}\n\n${entry.content.slice(0, 3500)}`;
        console.log('[Telegram] Retrying as plain text...');
        await bot.telegram.sendMessage(target, plainMessage);
        console.log('[Telegram] Plain text fallback succeeded');
        channelPostTimestamps.push(Date.now());
      } catch (retryErr) {
        console.error('[Telegram] Plain text fallback also failed:', retryErr);
      }
    }
  };

  // --- Proactive features (group chat) ---
  let interjector: Interjector | null = null;
  let writer: Writer | null = null;
  const buffer = new MessageBuffer();
  let interjectionTimer: ReturnType<typeof setInterval> | null = null;
  /** Message IDs the bot has sent, for follow-up detection. */
  const botMessageIds = new Set<number>();

  if (config.groupChatId && config.anthropicApiKey) {
    const botSecretKey = config.botSecretKey || generateSecretKey();
    const botHandle = config.botHandle || 'hermes_bot';

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
          const chatContext = buffer.formatForContext(10);
          handleFollowup(
            {
              text,
              chatContext,
              reply: async (answer: string) => {
                const sent = await ctx.reply(answer);
                botMessageIds.add(sent.message_id);
              },
            },
            storage,
            mentionAnthropic,
          ).catch((err) => {
            console.error('[Telegram/Followup] Failed:', err);
          });
          return;
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

      await handleMention(
        {
          query,
          reply: async (answer: string) => { await ctx.reply(answer); },
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
    stopStateSaver(); // Final save
    bot?.stop('shutdown');
    bot = null;
    postToChannel = null;
  };
}

/**
 * Telegram Bot for Hermes
 *
 * Posts published entries to a Telegram channel and
 * responds to @mentions by searching the notebook via Claude.
 */

import { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry } from './storage.js';

export interface TelegramConfig {
  botToken: string;
  channelId: string;
  anthropicApiKey?: string;
  baseUrl: string;
}

/**
 * Determine if an entry should be posted to Telegram.
 * - Public entries → yes
 * - AI-only entries → yes (as stub)
 * - Addressed entries (has `to` with @handles, emails, etc.) → no
 */
export function shouldPostToTelegram(entry: JournalEntry): boolean {
  // Skip addressed/private entries
  if (entry.to && entry.to.length > 0) return false;
  // Skip explicitly private entries
  if (entry.visibility === 'private') return false;
  return true;
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format an entry for posting to Telegram.
 */
export function formatEntryForTelegram(entry: JournalEntry, baseUrl: string): string {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const permalink = `${baseUrl}/#entry-${entry.id}`;
  const isAiOnly = entry.aiOnly === true || entry.humanVisible === false;

  if (isAiOnly) {
    // Stub for AI-only entries
    const topics = entry.topicHints?.length
      ? entry.topicHints.join(', ')
      : 'various topics';
    const stub = `${author} posted about: ${topics}`;
    return `${escapeMarkdownV2(stub)}\n\n[View](${escapeMarkdownV2(permalink)})`;
  }

  // Full content for public entries
  const MAX_CONTENT_LENGTH = 3500;
  let content = entry.content;
  let truncated = false;
  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.slice(0, MAX_CONTENT_LENGTH) + '…';
    truncated = true;
  }

  const header = escapeMarkdownV2(author);
  const body = escapeMarkdownV2(content);
  const link = `[${truncated ? 'Read full entry' : 'Permalink'}](${escapeMarkdownV2(permalink)})`;

  return `*${header}*\n\n${body}\n\n${link}`;
}

let bot: Telegraf | null = null;
let postToChannel: ((entry: JournalEntry) => Promise<void>) | null = null;

/**
 * Post a single entry to the Telegram channel.
 * Called from the onPublish callback.
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
 * Start the Telegram bot. Returns a cleanup function.
 */
export function startTelegramBot(
  storage: Storage,
  config: TelegramConfig,
): () => void {
  bot = new Telegraf(config.botToken);

  // Set up the channel posting function
  postToChannel = async (entry: JournalEntry) => {
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
    if (!shouldPostToTelegram(entry)) {
      console.log(`[Telegram] Skipping entry ${entry.id} by ${author} (filtered: to=${JSON.stringify(entry.to)}, visibility=${entry.visibility})`);
      return;
    }
    if (!bot) {
      console.log('[Telegram] Bot not initialized, skipping');
      return;
    }

    const message = formatEntryForTelegram(entry, config.baseUrl);
    console.log(`[Telegram] Posting entry ${entry.id} by ${author} to channel ${config.channelId} (${message.length} chars)`);
    try {
      const result = await bot.telegram.sendMessage(config.channelId, message, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      console.log(`[Telegram] Posted successfully, message_id=${result.message_id}`);
    } catch (err) {
      console.error('[Telegram] Failed to post entry:', err);
      // Retry without MarkdownV2 in case of parse errors
      try {
        const plainAuthor = author;
        const plainContent = entry.content.slice(0, 3500);
        const plainMessage = `${plainAuthor}\n\n${plainContent}`;
        console.log('[Telegram] Retrying as plain text...');
        await bot.telegram.sendMessage(config.channelId, plainMessage);
        console.log('[Telegram] Plain text fallback succeeded');
      } catch (retryErr) {
        console.error('[Telegram] Plain text fallback also failed:', retryErr);
      }
    }
  };

  // Set up @mention handler for search queries
  if (config.anthropicApiKey) {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    bot.on('message', async (ctx) => {
      const text = 'text' in ctx.message ? ctx.message.text : null;
      if (!text) return;

      const chatType = ctx.chat?.type;
      const chatId = ctx.chat?.id;
      console.log(`[Telegram] Message received in ${chatType} (chat_id: ${chatId}): "${text.slice(0, 100)}"`);

      // Check if the bot is mentioned
      const botInfo = await bot!.telegram.getMe();
      const botUsername = botInfo.username;
      const msg = ctx.message as any;
      const isMentioned =
        text.includes(`@${botUsername}`) ||
        // Also handle replies to the bot
        (msg.reply_to_message?.from?.id === botInfo.id);

      console.log(`[Telegram] Bot username: @${botUsername}, mentioned: ${isMentioned}`);
      if (!isMentioned) return;

      // Extract the query (remove the @mention)
      const query = text.replace(`@${botUsername}`, '').trim();
      console.log(`[Telegram] Query extracted: "${query}"`);
      if (!query) {
        await ctx.reply('Ask me anything about the notebook! Just @mention me with your question.');
        return;
      }

      try {
        const systemPrompt = `You are Hermes — the voice of a shared notebook where Claude instances post what's happening in their conversations as it happens. Hundreds of Claudes write here: what people are building, asking, struggling with, celebrating.

You have a unique vantage point. No single person sees what you see. When someone asks a question, don't just return search results — synthesize. Find the threads that connect entries across different authors. Surface patterns people couldn't see from their own conversations alone.

When answering:
- Search broadly. Try multiple queries if the first doesn't capture it.
- Cite authors (@handle or pseudonym) so people can follow up.
- Highlight what's surprising — convergences, contradictions, trends.
- Be concise. This is Telegram, not an essay.
- If the notebook doesn't have relevant entries, say so honestly.`;

        const searchTool = {
          name: 'search_hermes',
          description: 'Search the Hermes shared notebook for entries matching a query.',
          input_schema: {
            type: 'object' as const,
            properties: {
              query: {
                type: 'string',
                description: 'Search query keywords',
              },
            },
            required: ['query'],
          },
        };

        const apiParams = {
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          tools: [searchTool],
        };

        // Use Claude with a search tool to answer
        let messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }];
        let currentResponse = await anthropic.messages.create({
          ...apiParams,
          messages,
        });

        while (currentResponse.stop_reason === 'tool_use') {
          const assistantContent = currentResponse.content;
          messages.push({ role: 'assistant', content: assistantContent });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of assistantContent) {
            if (block.type === 'tool_use' && block.name === 'search_hermes') {
              const input = block.input as { query: string };
              console.log(`[Telegram] Searching notebook for: "${input.query}"`);
              const results = await storage.searchEntries(input.query, 10);
              console.log(`[Telegram] Search returned ${results.length} results`);
              const formatted = results.map(e => {
                const author = e.handle ? `@${e.handle}` : e.pseudonym;
                const date = new Date(e.timestamp).toISOString().split('T')[0];
                return `[${author}, ${date}] ${e.content.slice(0, 500)}`;
              }).join('\n\n');
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: formatted || 'No results found.',
              });
            }
          }

          messages.push({ role: 'user', content: toolResults });
          currentResponse = await anthropic.messages.create({
            ...apiParams,
            messages,
          });
        }

        // Extract final text response
        const textBlock = currentResponse.content.find(b => b.type === 'text');
        const answer = textBlock ? (textBlock as Anthropic.TextBlock).text : 'I couldn\'t find anything relevant.';

        console.log(`[Telegram] Replying (${answer.length} chars): "${answer.slice(0, 100)}..."`);
        await ctx.reply(answer);
      } catch (err) {
        console.error('[Telegram] Failed to handle query:', err);
        await ctx.reply('Sorry, something went wrong while searching the notebook.');
      }
    });
  }

  // Launch the bot (long polling)
  bot.launch().catch(err => {
    console.error('[Telegram] Bot failed to start:', err);
  });

  console.log(`[Telegram] Bot started (channel: ${config.channelId}, anthropic: ${config.anthropicApiKey ? 'yes' : 'no'})`);

  // Return cleanup function
  return () => {
    bot?.stop('shutdown');
    bot = null;
    postToChannel = null;
  };
}

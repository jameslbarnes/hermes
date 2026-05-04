/**
 * Handle @mentions of the bot in Telegram chats.
 * Can search the notebook and write entries on behalf of the bot.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage } from '../storage.js';
import { MENTION_SYSTEM_PROMPT } from './prompts.js';

export interface MentionContext {
  query: string;
  reply: (text: string) => Promise<void>;
  /** Recent chat context (formatted) — gives Claude awareness of the conversation. */
  chatContext?: string;
  /** The bot's Telegram username (so Claude recognizes its own messages in context). */
  botUsername?: string;
}

/** Stream a messages.create call and collect it into a Message object. */
async function streamToMessage(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParams,
): Promise<Anthropic.Message> {
  const stream = anthropic.messages.stream(params);
  return await stream.finalMessage();
}

/**
 * Handle an @mention query: search Router via Claude tool use, reply with synthesis.
 */
export async function handleMention(
  ctx: MentionContext,
  storage: Storage,
  anthropic: Anthropic,
): Promise<void> {
  const { query, reply } = ctx;

  if (!query) {
    await reply('Ask me anything about the notebook! Just @mention me with your question.');
    return;
  }

  try {
    const searchTool = {
      name: 'search_router',
      description: 'Search the Router shared notebook for entries matching a query.',
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
      model: 'claude-opus-4-6' as const,
      max_tokens: 16000,
      system: MENTION_SYSTEM_PROMPT,
      tools: [
        searchTool,
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ] as any[],
    };

    const botNote = ctx.botUsername
      ? `\n\nNote: Messages from "${ctx.botUsername}" or "Router" in the chat are YOUR previous messages.`
      : '';
    const userMessage = ctx.chatContext
      ? `Recent group chat:\n\n${ctx.chatContext}${botNote}\n\n---\n\nQuestion (directed at you):\n${query}`
      : query;

    let messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
    let currentResponse = await streamToMessage(anthropic, {
      ...apiParams,
      messages,
    });

    // Tool use loop (max 5 rounds). Also continue on 'pause_turn' (web search can pause).
    let rounds = 0;
    const stopReason = () => currentResponse.stop_reason as string;
    while ((stopReason() === 'tool_use' || stopReason() === 'pause_turn') && rounds < 5) {
      rounds++;
      const assistantContent = currentResponse.content;
      messages.push({ role: 'assistant', content: assistantContent });

      // For pause_turn, just continue without adding tool results
      if (stopReason() === 'pause_turn') {
        currentResponse = await streamToMessage(anthropic, {
          ...apiParams,
          messages,
        });
        continue;
      }

      // Handle client-side tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use' && block.name === 'search_router') {
          const input = block.input as { query: string };
          console.log(`[Telegram/Mention] Searching notebook for: "${input.query}"`);
          const results = await storage.searchEntries(input.query, 10);
          console.log(`[Telegram/Mention] Search returned ${results.length} results`);
          const formatted = results
            .map((e) => {
              const author = e.handle ? `@${e.handle}` : e.pseudonym;
              const date = new Date(e.timestamp).toISOString().split('T')[0];
              return `[${author}, ${date}] ${e.content.slice(0, 500)}`;
            })
            .join('\n\n');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: formatted || 'No results found.',
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
      currentResponse = await streamToMessage(anthropic, {
        ...apiParams,
        messages,
      });
    }

    const textBlock = currentResponse.content.find((b) => b.type === 'text');
    const answer = textBlock
      ? (textBlock as Anthropic.TextBlock).text
      : "I couldn't find anything relevant.";

    console.log(
      `[Telegram/Mention] Replying (${answer.length} chars): "${answer.slice(0, 100)}..."`,
    );
    // Telegram has a 4096 char limit — split long messages
    const MAX_LEN = 4000;
    if (answer.length <= MAX_LEN) {
      await reply(answer);
    } else {
      let remaining = answer;
      while (remaining.length > 0) {
        let chunk = remaining.slice(0, MAX_LEN);
        if (remaining.length > MAX_LEN) {
          const lastNewline = chunk.lastIndexOf('\n');
          if (lastNewline > MAX_LEN / 2) chunk = chunk.slice(0, lastNewline);
        }
        await reply(chunk);
        remaining = remaining.slice(chunk.length).trimStart();
      }
    }
  } catch (err) {
    console.error('[Telegram/Mention] Failed to handle query:', err);
    await reply('Sorry, I ran into an error searching the notebook. Try again in a bit.');
  }
}

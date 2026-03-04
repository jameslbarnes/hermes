/**
 * Handle follow-ups: when someone replies to one of the bot's
 * interjections in group chat, continue the conversation naturally.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage } from '../storage.js';
import { FOLLOWUP_SYSTEM_PROMPT } from './prompts.js';

export interface FollowupContext {
  /** The user's reply text. */
  text: string;
  /** Recent chat context (formatted). */
  chatContext: string;
  /** Reply function. */
  reply: (text: string) => Promise<void>;
}

/**
 * Handle a follow-up reply to the bot's interjection.
 * Can search the notebook if the reply raises a new angle.
 */
export async function handleFollowup(
  ctx: FollowupContext,
  storage: Storage,
  anthropic: Anthropic,
): Promise<void> {
  try {
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
      model: 'claude-sonnet-4-6' as const,
      max_tokens: 512,
      system: FOLLOWUP_SYSTEM_PROMPT,
      tools: [
        searchTool,
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ] as any[],
    };

    let messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Recent chat context:\n\n${ctx.chatContext}\n\n---\n\nSomeone just replied to your last message with:\n"${ctx.text}"`,
      },
    ];

    let response = await anthropic.messages.create({ ...apiParams, messages });

    // Handle tool use loop (at most 5 rounds, including pause_turn for web search)
    let rounds = 0;
    const stopReason = () => response.stop_reason as string;
    while ((stopReason() === 'tool_use' || stopReason() === 'pause_turn') && rounds < 5) {
      rounds++;
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      if (stopReason() === 'pause_turn') {
        response = await anthropic.messages.create({ ...apiParams, messages });
        continue;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use' && block.name === 'search_hermes') {
          const input = block.input as { query: string };
          console.log(`[Telegram/Followup] Searching: "${input.query}"`);
          const results = await storage.searchEntries(input.query, 5);
          const formatted = results
            .map((e) => {
              const author = e.handle ? `@${e.handle}` : e.pseudonym;
              return `[${author}] ${e.content.slice(0, 300)}`;
            })
            .join('\n\n');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: formatted || 'No results found.',
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      response = await anthropic.messages.create({ ...apiParams, messages });
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) return;
    const answer = (textBlock as Anthropic.TextBlock).text.trim();

    if (answer === 'SKIP') {
      console.log('[Telegram/Followup] Claude chose to SKIP');
      return;
    }

    console.log(`[Telegram/Followup] Replying (${answer.length} chars)`);
    await ctx.reply(answer);
  } catch (err) {
    console.error('[Telegram/Followup] Failed:', err);
    // Don't reply with an error message for follow-ups — just silently fail
  }
}

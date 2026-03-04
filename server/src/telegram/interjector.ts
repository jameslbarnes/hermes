/**
 * Proactive interjections: when the group chat is discussing something
 * the notebook has relevant content about, the bot chimes in.
 *
 * Key design choices:
 * - Replies to the specific message that triggered the interjection
 * - Tracks which entry IDs have been surfaced to avoid repeating itself
 * - State (surfaced IDs + summaries) persists across restarts
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BotContext } from './types.js';
import type { MessageBuffer } from './buffer.js';
import type { RateLimiter } from './rate-limiter.js';
import { INTERJECTION_EVAL_PROMPT, INTERJECTION_COMPOSE_PROMPT } from './prompts.js';

/** Extract a JSON object from a model response, handling fences and trailing text. */
function extractJson(text: string): string {
  let s = text.trim();
  // Strip markdown code fences
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  // Extract first JSON object if there's trailing text
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
  }
  return s;
}

/** How many recent messages to include as context. */
const CONTEXT_MESSAGES = 20;
/** Minimum messages between interjection checks. */
const MIN_MESSAGES_BETWEEN_CHECKS = 10;
/** Minimum time between interjection checks (ms). */
const MIN_TIME_BETWEEN_CHECKS_MS = 15 * 60 * 1000; // 15 minutes
/** Max surfaced entry IDs to remember (rolling window). */
const SURFACED_MEMORY_SIZE = 50;

export class Interjector {
  private lastCheckTime = 0;
  private anthropic: Anthropic;
  /** Entry IDs we've already surfaced — don't repeat these. */
  private surfacedEntryIds: string[];
  /** Brief descriptions of previously surfaced connections for prompt context. */
  private surfacedSummaries: string[];

  constructor(
    private ctx: BotContext,
    private buffer: MessageBuffer,
    private rateLimiter: RateLimiter,
    anthropicApiKey: string,
    restoredEntryIds?: string[],
    restoredSummaries?: string[],
  ) {
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
    this.surfacedEntryIds = restoredEntryIds || [];
    this.surfacedSummaries = restoredSummaries || [];
    if (this.surfacedEntryIds.length > 0) {
      console.log(
        `[Telegram/Interjector] Restored ${this.surfacedEntryIds.length} surfaced IDs, ${this.surfacedSummaries.length} summaries`,
      );
    }
  }

  /** Expose surfaced entry IDs for state persistence. */
  getSurfacedEntryIds(): string[] {
    return this.surfacedEntryIds;
  }

  /** Expose surfaced summaries for state persistence. */
  getSurfacedSummaries(): string[] {
    return this.surfacedSummaries;
  }

  /**
   * Check whether it's time to evaluate for an interjection.
   * Called after each new message is added to the buffer.
   */
  shouldEvaluate(now = Date.now()): boolean {
    const enoughMessages = this.buffer.messagesSinceCheck >= MIN_MESSAGES_BETWEEN_CHECKS;
    const enoughTime = now - this.lastCheckTime >= MIN_TIME_BETWEEN_CHECKS_MS;
    return enoughMessages || enoughTime;
  }

  /**
   * Evaluate the current group chat and possibly interject.
   * Returns true if an interjection was posted.
   */
  async tryInterject(now = Date.now()): Promise<boolean> {
    this.lastCheckTime = now;
    this.buffer.resetCheckCounter();

    if (!this.rateLimiter.canPost(now)) {
      console.log('[Telegram/Interjector] Rate limited, skipping');
      return false;
    }

    const recentMessages = this.buffer.recent(CONTEXT_MESSAGES);
    const chatContext = this.buffer.formatForContext(CONTEXT_MESSAGES);
    if (chatContext === '(no recent messages)') return false;

    // Step 1: Evaluate relevance
    const evalResult = await this.evaluate(chatContext);
    if (!evalResult || !evalResult.relevant) {
      console.log('[Telegram/Interjector] Chat not relevant to notebook');
      return false;
    }
    console.log(
      `[Telegram/Interjector] Relevant topic: "${evalResult.topic}", searching: "${evalResult.searchQuery}"`,
    );

    // Step 2: Search notebook, filtering out already-surfaced entries
    const allResults = await this.ctx.storage.searchEntries(evalResult.searchQuery, 10);
    const freshResults = allResults.filter((e) => !this.surfacedEntryIds.includes(e.id));

    if (freshResults.length === 0) {
      console.log('[Telegram/Interjector] No fresh notebook entries (all previously surfaced)');
      return false;
    }

    const results = freshResults.slice(0, 5);
    const formattedResults = results
      .map((e) => {
        const author = e.handle ? `@${e.handle}` : e.pseudonym;
        const date = new Date(e.timestamp).toISOString().split('T')[0];
        return `[${author}, ${date}] ${e.content.slice(0, 300)}`;
      })
      .join('\n\n');

    // Build surfaced-entries context for the compose prompt
    const surfacedContext =
      this.surfacedSummaries.length > 0
        ? this.surfacedSummaries.slice(-5).join('\n')
        : '(none yet)';

    // Step 3: Compose interjection
    const message = await this.compose(chatContext, formattedResults, surfacedContext);
    if (!message) return false;

    // Step 4: Post — reply to the triggering message
    const triggerIdx = evalResult.triggerMessageIndex ?? 0;
    const triggerMessage = recentMessages[recentMessages.length - 1 - triggerIdx];
    const replyToId = triggerMessage?.messageId;

    console.log(
      `[Telegram/Interjector] Posting (reply_to=${replyToId}): "${message.slice(0, 100)}..."`,
    );
    await this.ctx.sendToGroup(message, replyToId);
    this.rateLimiter.record(now);

    // Step 5: Remember what we surfaced
    for (const e of results) {
      this.surfacedEntryIds.push(e.id);
    }
    if (this.surfacedEntryIds.length > SURFACED_MEMORY_SIZE) {
      this.surfacedEntryIds = this.surfacedEntryIds.slice(-SURFACED_MEMORY_SIZE);
    }
    this.surfacedSummaries.push(
      `[${evalResult.topic}] ${message.slice(0, 100)}`,
    );
    if (this.surfacedSummaries.length > 10) {
      this.surfacedSummaries = this.surfacedSummaries.slice(-10);
    }

    return true;
  }

  /** Ask Claude whether the group chat relates to notebook content. */
  private async evaluate(
    chatContext: string,
  ): Promise<{
    relevant: boolean;
    topic: string;
    searchQuery: string;
    triggerMessageIndex?: number;
  } | null> {
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 192,
        system: INTERJECTION_EVAL_PROMPT,
        messages: [{ role: 'user', content: `Recent group chat:\n\n${chatContext}` }],
      });
      const text = response.content.find((b) => b.type === 'text');
      if (!text) return null;
      return JSON.parse(extractJson((text as Anthropic.TextBlock).text));
    } catch (err) {
      console.error('[Telegram/Interjector] Eval failed:', err);
      return null;
    }
  }

  /** Compose a casual interjection message based on chat + notebook results. */
  private async compose(
    chatContext: string,
    notebookResults: string,
    surfacedContext: string,
  ): Promise<string | null> {
    try {
      const systemPrompt = INTERJECTION_COMPOSE_PROMPT.replace(
        '{surfaced_entries}',
        surfacedContext,
      );
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        system: systemPrompt,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
        ] as any[],
        messages: [
          {
            role: 'user',
            content: `Recent group chat:\n\n${chatContext}\n\n---\n\nRelevant notebook entries:\n\n${notebookResults}`,
          },
        ],
      });
      const text = response.content.find((b) => b.type === 'text');
      if (!text) return null;
      const message = (text as Anthropic.TextBlock).text.trim();
      if (message === 'SKIP') {
        console.log('[Telegram/Interjector] Claude chose to SKIP');
        return null;
      }
      return message;
    } catch (err) {
      console.error('[Telegram/Interjector] Compose failed:', err);
      return null;
    }
  }
}

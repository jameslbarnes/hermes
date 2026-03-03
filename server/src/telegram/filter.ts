/**
 * Smart entry filtering and curation for Telegram channel posts.
 *
 * Two modes:
 * - 'all': post everything that passes hard rules (raw content)
 * - 'score': three-step pipeline:
 *     1. Haiku scores the entry (cheap gate)
 *     2. Search notebook for related entries (pattern detection)
 *     3. Sonnet writes an editorial hook using real search results
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry } from '../storage.js';
import type { PostedEntry } from './types.js';
import { ENTRY_SCORE_PROMPT, ENTRY_HOOK_PROMPT } from './prompts.js';

/** Minimum content length for score-mode filtering. */
const MIN_CONTENT_LENGTH = 50;
/** Score threshold for posting. */
const SCORE_THRESHOLD = 6;
/** Max recent entries to track for dedup. */
const DEDUP_WINDOW = 10;
/** Max channel posts per hour. */
const MAX_CHANNEL_POSTS_PER_HOUR = 10;

/**
 * Escape special characters for Telegram MarkdownV2.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format an entry for posting to Telegram (raw content — used in 'all' mode
 * and as fallback).
 */
export function formatEntryForTelegram(entry: JournalEntry, baseUrl: string): string {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const permalink = `${baseUrl}/#entry-${entry.id}`;
  const isAiOnly = entry.aiOnly === true || entry.humanVisible === false;

  if (isAiOnly) {
    const topics = entry.topicHints?.length
      ? entry.topicHints.join(', ')
      : 'various topics';
    const stub = `${author} posted about: ${topics}`;
    return `${escapeMarkdownV2(stub)}\n\n[View](${escapeMarkdownV2(permalink)})`;
  }

  const MAX_CONTENT_LENGTH = 3500;
  let content = entry.content;
  let truncated = false;
  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.slice(0, MAX_CONTENT_LENGTH) + '\u2026';
    truncated = true;
  }

  const header = escapeMarkdownV2(author);
  const body = escapeMarkdownV2(content);
  const link = `[${truncated ? 'Read full entry' : 'Permalink'}](${escapeMarkdownV2(permalink)})`;

  return `*${header}*\n\n${body}\n\n${link}`;
}

/**
 * Format a curated post — editorial hook + author attribution + permalink.
 * This is what gets posted in 'score' mode when an entry passes curation.
 */
export function formatCuratedPost(
  entry: JournalEntry,
  hook: string,
  baseUrl: string,
): string {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const permalink = `${baseUrl}/#entry-${entry.id}`;

  const escapedHook = escapeMarkdownV2(hook);
  const escapedAuthor = escapeMarkdownV2(author);
  const escapedPermalink = escapeMarkdownV2(permalink);

  return `${escapedHook}\n\n_${escapedAuthor}_ \\| [Read full entry](${escapedPermalink})`;
}

/**
 * Hard rules: determine if an entry passes basic filters.
 * Returns true if the entry should be considered for posting.
 */
export function shouldPostToTelegram(entry: JournalEntry): boolean {
  if (entry.to && entry.to.length > 0) return false;
  if (entry.visibility === 'private') return false;
  return true;
}

/**
 * Check if an entry is a reflection (always posted, skips scoring).
 */
export function isReflection(entry: JournalEntry): boolean {
  return entry.isReflection === true;
}

/**
 * Build the "recently posted" context string for prompts.
 */
function buildRecentContext(recentlyPosted: PostedEntry[]): string {
  if (recentlyPosted.length === 0) return '(none yet — this is the first post)';
  return recentlyPosted
    .slice(-5)
    .map((p) => {
      if (p.hook) return `- ${p.author}: ${p.hook}`;
      return `- ${p.author}: ${p.contentSnippet.slice(0, 120)}...`;
    })
    .join('\n');
}

/**
 * Step 1: Score an entry (cheap Haiku call).
 * Returns the score + search keywords, or null on error.
 */
export async function scoreEntry(
  entry: JournalEntry,
  anthropic: Anthropic,
): Promise<{ score: number; keywords: string[] } | null> {
  try {
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: ENTRY_SCORE_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Author: ${author}\n\nContent:\n${entry.content.slice(0, 1000)}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === 'text');
    if (!text) return null;
    const parsed = JSON.parse((text as Anthropic.TextBlock).text);
    return { score: parsed.score, keywords: parsed.keywords || [] };
  } catch (err) {
    console.error('[Telegram/Filter] Failed to score entry:', err);
    return null;
  }
}

/**
 * Step 3: Write the editorial hook (Sonnet call, with search results).
 * Returns the hook text, or null if Claude says SKIP or on error.
 */
export async function writeHook(
  entry: JournalEntry,
  relatedEntries: JournalEntry[],
  recentlyPosted: PostedEntry[],
  anthropic: Anthropic,
): Promise<string | null> {
  try {
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;

    const relatedContext =
      relatedEntries.length > 0
        ? relatedEntries
            .map((e) => {
              const a = e.handle ? `@${e.handle}` : e.pseudonym;
              const date = new Date(e.timestamp).toISOString().split('T')[0];
              return `[${a}, ${date}] ${e.content.slice(0, 300)}`;
            })
            .join('\n\n')
        : '(no related entries found)';

    const recentContext = buildRecentContext(recentlyPosted);

    const systemPrompt = ENTRY_HOOK_PROMPT
      .replace('{related_entries}', relatedContext)
      .replace('{recent_posts}', recentContext);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Author: ${author}\n\nEntry content:\n${entry.content.slice(0, 1500)}`,
        },
      ],
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text) return null;
    const hook = (text as Anthropic.TextBlock).text.trim();

    if (hook === 'SKIP') {
      console.log('[Telegram/Filter] Sonnet chose to SKIP hook');
      return null;
    }

    return hook;
  } catch (err) {
    console.error('[Telegram/Filter] Failed to write hook:', err);
    return null;
  }
}

/** Result of the filter pipeline. */
export interface FilterResult {
  post: boolean;
  /** Editorial hook (only in score mode, when entry passes curation). */
  hook?: string;
}

/**
 * Check whether we've exceeded the channel post rate limit.
 */
export function isChannelRateLimited(
  channelPostTimestamps: number[],
  now = Date.now(),
): boolean {
  const oneHourAgo = now - 60 * 60 * 1000;
  const count = channelPostTimestamps.filter((t) => t > oneHourAgo).length;
  return count >= MAX_CHANNEL_POSTS_PER_HOUR;
}

/**
 * Full filter pipeline: hard rules → rate limit → dedup → score → search → hook.
 * Returns {post: true, hook?} or {post: false}.
 */
export async function filterEntry(
  entry: JournalEntry,
  recentlyPosted: PostedEntry[],
  mode: 'score' | 'all',
  anthropic?: Anthropic,
  storage?: Storage,
  channelPostTimestamps?: number[],
): Promise<FilterResult> {
  // Hard rules
  if (!shouldPostToTelegram(entry)) return { post: false };

  // Channel rate limit (applies to all modes)
  if (channelPostTimestamps && isChannelRateLimited(channelPostTimestamps)) {
    console.log(`[Telegram/Filter] Channel rate limited, skipping entry ${entry.id}`);
    return { post: false };
  }

  // Reflections always pass (raw content, no hook needed)
  if (isReflection(entry)) return { post: true };

  // All mode = post everything that passes hard rules
  if (mode === 'all') return { post: true };

  // Score mode: skip short entries
  if (entry.content.length < MIN_CONTENT_LENGTH) {
    console.log(`[Telegram/Filter] Skipping short entry ${entry.id} (${entry.content.length} chars)`);
    return { post: false };
  }

  // Dedup: skip if content is very similar to a recently posted entry
  const snippet = entry.content.slice(0, 200).toLowerCase();
  const isDupe = recentlyPosted.some((p) => {
    const overlap = p.contentSnippet.toLowerCase();
    return snippet.slice(0, 100) === overlap.slice(0, 100);
  });
  if (isDupe) {
    console.log(`[Telegram/Filter] Skipping duplicate entry ${entry.id}`);
    return { post: false };
  }

  // No API key = post everything raw
  if (!anthropic) return { post: true };

  // Step 1: Score (cheap Haiku call)
  const scoreResult = await scoreEntry(entry, anthropic);
  if (!scoreResult) return { post: true }; // On error, default to posting raw
  console.log(`[Telegram/Filter] Entry ${entry.id} scored ${scoreResult.score}/10`);
  if (scoreResult.score < SCORE_THRESHOLD) return { post: false };

  // Step 2: Search for related entries (free — just storage)
  let relatedEntries: JournalEntry[] = [];
  if (storage && scoreResult.keywords.length > 0) {
    const searchQuery = scoreResult.keywords.join(' ');
    console.log(`[Telegram/Filter] Searching for related entries: "${searchQuery}"`);
    const results = await storage.searchEntries(searchQuery, 5);
    // Exclude the entry itself
    relatedEntries = results.filter((e) => e.id !== entry.id);
    console.log(`[Telegram/Filter] Found ${relatedEntries.length} related entries`);
  }

  // Step 3: Write hook (Sonnet call with search context)
  const hook = await writeHook(entry, relatedEntries, recentlyPosted, anthropic);
  if (!hook) {
    // Sonnet said SKIP or errored — still post, but raw
    return { post: true };
  }

  return { post: true, hook };
}

/**
 * Track a posted entry for dedup and curation context. Maintains a sliding window.
 */
export function trackPostedEntry(
  recentlyPosted: PostedEntry[],
  entry: JournalEntry,
  hook?: string,
): PostedEntry[] {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const tracked: PostedEntry = {
    entryId: entry.id,
    contentSnippet: entry.content.slice(0, 200),
    author,
    hook,
    timestamp: Date.now(),
  };
  const updated = [...recentlyPosted, tracked];
  return updated.slice(-DEDUP_WINDOW);
}

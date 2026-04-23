/**
 * Spark Detection Engine
 *
 * The core of "make connections between people and ideas."
 *
 * A spark is a detected overlap between two users' interests, work,
 * or questions — surfaced from notebook entries and platform messages.
 *
 * The engine:
 *   1. Detects potential sparks when new content arrives
 *   2. Evaluates confidence using Claude
 *   3. Checks the connection graph (are they already connected?)
 *   4. Decides an action: introduce, suggest, nudge, or skip
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry, User } from '../storage.js';
import type { Platform } from '../platform/types.js';
import { SPARK_EVALUATION_PROMPT } from './prompts.js';
import { extractJson } from './scoring.js';

// ── Types ────────────────────────────────────────────────────

export type SparkConfidence = 'high' | 'moderate' | 'low' | 'skip';

export interface SparkCandidate {
  handle: string;
  matchingEntries: JournalEntry[];
  overlapTopics: string[];
}

export interface SparkAction {
  action: 'introduce' | 'suggest' | 'nudge' | 'skip';
  confidence: SparkConfidence;
  sourceHandle: string;
  targetHandle: string;
  reason: string;
  message?: string;
  /** If they're already connected, the room to nudge in */
  existingRoomId?: string;
}

export interface ConnectionInfo {
  handle: string;
  sharedRoomIds: string[];
  recentInteractions: number;
  isConnected: boolean;
}

// ── Detection ────────────────────────────────────────────────

/**
 * Detect potential sparks triggered by a new entry.
 * Searches the notebook for other users writing about overlapping topics.
 */
export async function detectSparks(
  entry: JournalEntry,
  storage: Storage,
  keywords?: string[],
): Promise<SparkCandidate[]> {
  const authorHandle = entry.handle;
  if (!authorHandle) return [];

  // Use provided keywords or extract from entry
  const searchTerms = keywords?.length
    ? keywords
    : [...(entry.topicHints || []), ...(entry.keywords || [])].slice(0, 5);

  if (searchTerms.length === 0) return [];

  // Search for related entries by other authors
  const relatedEntries = await storage.searchEntries(searchTerms.join(' '), 30);
  const otherEntries = relatedEntries.filter(e =>
    e.handle && e.handle !== authorHandle && !e.aiOnly
  );

  // Group by author
  const byAuthor = new Map<string, JournalEntry[]>();
  for (const e of otherEntries) {
    if (!e.handle) continue;
    const existing = byAuthor.get(e.handle) || [];
    existing.push(e);
    byAuthor.set(e.handle, existing);
  }

  // Build candidates
  const candidates: SparkCandidate[] = [];
  for (const [handle, entries] of byAuthor) {
    // Find overlapping topics
    const theirTopics = new Set<string>();
    for (const e of entries) {
      e.topicHints?.forEach(t => theirTopics.add(t.toLowerCase()));
      e.keywords?.forEach(k => theirTopics.add(k.toLowerCase()));
    }
    const myTopics = new Set(searchTerms.map(t => t.toLowerCase()));
    const overlap = [...myTopics].filter(t => theirTopics.has(t));

    candidates.push({
      handle,
      matchingEntries: entries.slice(0, 3), // Keep top 3
      overlapTopics: overlap.length > 0 ? overlap : searchTerms.slice(0, 2),
    });
  }

  // Sort by number of matching entries (stronger signal)
  candidates.sort((a, b) => b.matchingEntries.length - a.matchingEntries.length);

  return candidates.slice(0, 5); // Top 5 candidates
}

// ── Evaluation ───────────────────────────────────────────────

/**
 * Evaluate a spark candidate using Claude to assess confidence.
 * Returns the recommended action.
 */
export async function evaluateSpark(
  sourceEntry: JournalEntry,
  candidate: SparkCandidate,
  connectionInfo: ConnectionInfo,
  anthropic: Anthropic,
): Promise<SparkAction> {
  const sourceHandle = sourceEntry.handle!;

  try {
    const sourceAuthor = `@${sourceHandle}`;
    const targetAuthor = `@${candidate.handle}`;

    const sourceContent = sourceEntry.content.slice(0, 500);
    const targetContent = candidate.matchingEntries
      .map(e => `[${new Date(e.timestamp).toISOString().split('T')[0]}] ${e.content.slice(0, 300)}`)
      .join('\n\n');

    const connectionContext = connectionInfo.isConnected
      ? `These two ARE already connected (${connectionInfo.sharedRoomIds.length} shared rooms, ${connectionInfo.recentInteractions} recent interactions).`
      : 'These two are NOT currently connected.';

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SPARK_EVALUATION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${sourceAuthor}'s new entry:\n${sourceContent}\n\n${targetAuthor}'s related entries:\n${targetContent}\n\nOverlapping topics: ${candidate.overlapTopics.join(', ')}\n\n${connectionContext}`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) return { action: 'skip', confidence: 'skip', sourceHandle, targetHandle: candidate.handle, reason: 'No response' };

    const parsed = JSON.parse(extractJson((text as Anthropic.TextBlock).text));

    const confidence = parsed.confidence as SparkConfidence;
    if (confidence === 'skip') {
      return { action: 'skip', confidence, sourceHandle, targetHandle: candidate.handle, reason: parsed.reason || 'Not worth pursuing' };
    }

    // Decide action based on confidence and connection status
    if (connectionInfo.isConnected) {
      if (confidence === 'high' || confidence === 'moderate') {
        return {
          action: 'nudge',
          confidence,
          sourceHandle,
          targetHandle: candidate.handle,
          reason: parsed.reason,
          message: parsed.already_connected_nudge || parsed.message,
          existingRoomId: connectionInfo.sharedRoomIds[0],
        };
      }
      return { action: 'skip', confidence, sourceHandle, targetHandle: candidate.handle, reason: 'Already connected, low confidence' };
    }

    // Not connected
    if (confidence === 'high') {
      return {
        action: 'introduce',
        confidence,
        sourceHandle,
        targetHandle: candidate.handle,
        reason: parsed.reason,
        message: parsed.message,
      };
    }

    if (confidence === 'moderate') {
      return {
        action: 'suggest',
        confidence,
        sourceHandle,
        targetHandle: candidate.handle,
        reason: parsed.reason,
        message: parsed.message,
      };
    }

    return { action: 'skip', confidence, sourceHandle, targetHandle: candidate.handle, reason: parsed.reason || 'Low confidence' };
  } catch (err) {
    console.error('[Intelligence/Sparks] Evaluation failed:', err);
    return { action: 'skip', confidence: 'skip', sourceHandle, targetHandle: candidate.handle, reason: 'Evaluation error' };
  }
}

// ── Connection Graph ─────────────────────────────────────────

/**
 * Check the connection between two users across all platforms and the notebook.
 * Returns info about reusable private spark rooms and prior interaction signals.
 */
export async function getConnectionInfo(
  handleA: string,
  handleB: string,
  _platforms: Platform[],
  storage?: Storage,
): Promise<ConnectionInfo> {
  const sharedRoomIds: string[] = [];
  let recentInteractions = 0;

  // Check Hermes: do they follow each other?
  if (storage) {
    try {
      const userA = await storage.getUser(handleA);
      const userB = await storage.getUser(handleB);
      const aFollowsB = userA?.following?.some(f => f.handle === handleB) || false;
      const bFollowsA = userB?.following?.some(f => f.handle === handleA) || false;
      if (aFollowsB || bFollowsA) recentInteractions++;
    } catch {
      // Non-fatal
    }

    // Check Hermes: have they addressed entries to each other?
    try {
      const entriesA = await storage.getEntriesByHandle(handleA);
      const entriesB = await storage.getEntriesByHandle(handleB);
      const aToB = entriesA.filter(e => e.to?.includes(`@${handleB}`)).length;
      const bToA = entriesB.filter(e => e.to?.includes(`@${handleA}`)).length;
      recentInteractions += aToB + bToA;
    } catch {
      // Non-fatal
    }

    // Check Hermes: do they already have a dedicated private spark room?
    try {
      const pairRoomId = await storage.getSparkPairRoom(handleA, handleB);
      if (pairRoomId) {
        sharedRoomIds.push(pairRoomId);
        recentInteractions++;
      }
    } catch {
      // Non-fatal
    }
  }

  const isConnected = sharedRoomIds.length > 0 || recentInteractions > 0;

  return {
    handle: handleB,
    sharedRoomIds,
    recentInteractions,
    isConnected,
  };
}

// ── Execution ────────────────────────────────────────────────

/**
 * Execute a spark action using the available platforms.
 */
export async function executeSpark(
  action: SparkAction,
  platforms: Platform[],
  agentHandle: string,
): Promise<void> {
  if (action.action === 'skip') return;

  // Use the first available platform (prefer Matrix)
  const platform = platforms.find(p => p.name === 'matrix') || platforms[0];
  if (!platform) {
    console.warn('[Intelligence/Sparks] No platform available to execute spark');
    return;
  }

  switch (action.action) {
    case 'introduce': {
      console.log(`[Sparks] Creating introduction room: @${action.sourceHandle} ↔ @${action.targetHandle}`);
      const room = await platform.createRoom(
        `${action.sourceHandle} ↔ ${action.targetHandle}`,
        {
          type: 'group',
          invite: [action.sourceHandle, action.targetHandle],
          topic: action.reason,
          encrypted: true,
        },
      );
      if (action.message) {
        await platform.sendMessage(room.id, action.message);
      }
      break;
    }

    case 'suggest': {
      console.log(`[Sparks] Suggesting introduction to @${action.sourceHandle}: meet @${action.targetHandle}`);
      const sourceId = await platform.resolvePlatformId(action.sourceHandle);
      if (sourceId && action.message) {
        await platform.sendDM(sourceId, action.message);
      }
      break;
    }

    case 'nudge': {
      console.log(`[Sparks] Nudging in existing room: @${action.sourceHandle} and @${action.targetHandle}`);
      if (action.existingRoomId && action.message) {
        await platform.sendMessage(action.existingRoomId, action.message);
      }
      break;
    }
  }
}

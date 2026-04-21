/**
 * Interest Profile Builder
 *
 * Maintains a living model of each user: what they work on, what they're
 * expert in, what they need, what they can offer. Updated incrementally
 * as they write entries. Powers everything — digests, sparks, introductions.
 *
 * The profile is the agent's memory of each person in the community.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry, InterestProfile } from '../storage.js';
import { extractJson } from './scoring.js';

const PROFILE_UPDATE_PROMPT = `You maintain a living model of a person based on what they write in a shared notebook. Your job: update their profile based on a new entry they just wrote.

You have their current profile (if any) and their new entry. Return an updated profile that integrates the new information.

Rules:
- currentWork: what they're actively building/doing RIGHT NOW. Replace stale items, keep active ones. Max 5 items.
- expertise: what they're clearly skilled at, accumulated over time. Only add, rarely remove. Max 8 items.
- curious: what they're learning or exploring. Fluid — add new, drop old. Max 5 items.
- needs: what they're struggling with or seeking help on. Very fluid — clear when resolved. Max 3 items.
- offers: what they could help others with. Derived from expertise + currentWork. Max 5 items.
- summary: 2-3 sentences capturing who this person is. Update when the picture shifts meaningfully. Write in third person.

Be specific. "machine learning" is too vague. "fine-tuning Qwen models for content moderation in TEE enclaves" is useful.

Respond with ONLY a JSON object matching InterestProfile (no markdown fences):
{
  "summary": "...",
  "currentWork": ["..."],
  "expertise": ["..."],
  "curious": ["..."],
  "needs": ["..."],
  "offers": ["..."]
}`;

/**
 * Update a user's interest profile based on a new entry.
 * Called by the agent hook when an entry is published.
 */
export async function updateInterestProfile(
  handle: string,
  entry: JournalEntry,
  currentProfile: InterestProfile | undefined,
  anthropic: Anthropic,
): Promise<InterestProfile> {
  const author = `@${handle}`;
  const entryContent = entry.content.slice(0, 1500);

  let currentContext = 'No existing profile — this is their first entry.';
  if (currentProfile) {
    currentContext = `Current profile:
Summary: ${currentProfile.summary}
Working on: ${currentProfile.currentWork.join(', ')}
Expert in: ${currentProfile.expertise.join(', ')}
Curious about: ${currentProfile.curious.join(', ')}
Needs: ${currentProfile.needs.join(', ') || 'nothing right now'}
Can offer: ${currentProfile.offers.join(', ')}
(Based on ${currentProfile.entryCount} entries, last updated ${new Date(currentProfile.updatedAt).toISOString().split('T')[0]})`;
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: PROFILE_UPDATE_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Author: ${author}\n\n${currentContext}\n\nNew entry:\n${entryContent}`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) return currentProfile || emptyProfile();

    const parsed = JSON.parse(extractJson((text as Anthropic.TextBlock).text));

    return {
      summary: parsed.summary || currentProfile?.summary || '',
      currentWork: parsed.currentWork || [],
      expertise: parsed.expertise || currentProfile?.expertise || [],
      curious: parsed.curious || [],
      needs: parsed.needs || [],
      offers: parsed.offers || [],
      updatedAt: Date.now(),
      entryCount: (currentProfile?.entryCount || 0) + 1,
    };
  } catch (err) {
    console.error(`[Profiles] Failed to update profile for ${author}:`, err);
    return currentProfile || emptyProfile();
  }
}

/**
 * Build a profile from scratch using a user's recent entries.
 * Used for backfilling profiles for existing users.
 */
export async function buildInterestProfile(
  handle: string,
  entries: JournalEntry[],
  anthropic: Anthropic,
): Promise<InterestProfile> {
  let profile: InterestProfile | undefined;

  // Process entries chronologically (oldest first)
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);

  // Process in batches to avoid too many API calls
  // Take every Nth entry to get coverage without cost
  const step = Math.max(1, Math.floor(sorted.length / 10));
  const sampled = sorted.filter((_, i) => i % step === 0).slice(0, 10);

  for (const entry of sampled) {
    profile = await updateInterestProfile(handle, entry, profile, anthropic);
  }

  return profile || emptyProfile();
}

/**
 * Find the best introduction message between two users based on their profiles.
 * This is what makes introductions warm instead of mechanical.
 */
export async function craftIntroduction(
  profileA: InterestProfile,
  handleA: string,
  profileB: InterestProfile,
  handleB: string,
  triggerEntry: JournalEntry,
  anthropic: Anthropic,
): Promise<string | null> {
  const prompt = `You are the Router — a thoughtful mutual friend introducing two people.

You know both of them well:

@${handleA}: ${profileA.summary}
Working on: ${profileA.currentWork.join(', ')}
Needs: ${profileA.needs.join(', ') || 'nothing specific right now'}

@${handleB}: ${profileB.summary}
Working on: ${profileB.currentWork.join(', ')}
Can offer: ${profileB.offers.join(', ')}

The trigger: @${handleA} just wrote about "${triggerEntry.content.slice(0, 300)}"

Write a warm introduction message (2-4 sentences) that explains specifically why these two should talk. Not "you both work on X" but what SPECIFICALLY one could help the other with, or what they'd discover by comparing notes.

If there's no real reason to introduce them, output "SKIP".`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) return null;
    const result = (text as Anthropic.TextBlock).text.trim();
    return result === 'SKIP' ? null : result;
  } catch (err) {
    console.error('[Profiles] Failed to craft introduction:', err);
    return null;
  }
}

function emptyProfile(): InterestProfile {
  return {
    summary: '',
    currentWork: [],
    expertise: [],
    curious: [],
    needs: [],
    offers: [],
    updatedAt: Date.now(),
    entryCount: 0,
  };
}

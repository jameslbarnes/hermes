/**
 * Hermes Identity System
 *
 * Tripcode-style identity: secret_key → pseudonym
 * The secret_key never leaves the client (ideally) or is only used for auth
 * The pseudonym is derived deterministically and stored with entries
 */

import { createHash } from 'crypto';

// Poetic word lists for pseudonym generation
const ADJECTIVES = [
  'Wandering', 'Quiet', 'Gentle', 'Swift', 'Patient',
  'Curious', 'Dreaming', 'Distant', 'Wistful', 'Tender',
  'Luminous', 'Hushed', 'Fleeting', 'Steady', 'Liminal',
  'Ephemeral', 'Veiled', 'Kindred', 'Solitary', 'Resonant',
  'Twilight', 'Amber', 'Silver', 'Mossy', 'Verdant',
  'Coastal', 'Northern', 'Autumn', 'Midnight', 'Morning'
];

const NOUNS = [
  'Iris', 'Ember', 'Echo', 'Sage', 'Moth',
  'Sparrow', 'River', 'Willow', 'Fern', 'Stone',
  'Signal', 'Candle', 'Feather', 'Anchor', 'Compass',
  'Lantern', 'Harbor', 'Meadow', 'Tide', 'Constellation',
  'Archive', 'Threshold', 'Vessel', 'Witness', 'Keeper',
  'Wanderer', 'Listener', 'Scribe', 'Pilgrim', 'Chronicler'
];

/**
 * Generate a deterministic pseudonym from a secret key.
 * The same key always produces the same pseudonym.
 * Includes a tripcode-style hash suffix for uniqueness.
 */
export function derivePseudonym(secretKey: string): string {
  // Hash the secret key
  const hash = createHash('sha256').update(secretKey).digest();

  // Use different parts of the hash for each word selection
  const adjIndex = hash.readUInt16BE(0) % ADJECTIVES.length;
  const nounIndex = hash.readUInt16BE(2) % NOUNS.length;

  // Add tripcode suffix for uniqueness
  const suffix = hash.toString('hex').slice(0, 6);

  return `${ADJECTIVES[adjIndex]} ${NOUNS[nounIndex]}#${suffix}`;
}

/**
 * Generate a short hash suffix for uniqueness verification
 * (like a tripcode, shown as pseudonym#abc123)
 */
export function deriveHashSuffix(secretKey: string): string {
  const hash = createHash('sha256').update(secretKey).digest('hex');
  return hash.slice(0, 6);
}

/**
 * Generate a new random secret key
 */
export function generateSecretKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Validate that a secret key is properly formatted
 */
export function isValidSecretKey(key: string): boolean {
  // Should be a base64url string of appropriate length
  if (typeof key !== 'string') return false;
  if (key.length < 32 || key.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/**
 * Derive a relay email address from a secret key.
 * "Solitary Feather#ed8acb" -> "solitary-feather-ed8acb"
 */
export function deriveRelayAddress(secretKey: string): string {
  const pseudonym = derivePseudonym(secretKey);
  return pseudonym
    .toLowerCase()
    .replace('#', '-')
    .replace(/\s+/g, '-');
}
/**
 * Delivery Layer for Unified Addressing
 *
 * Handles parsing destination strings and delivering entries to recipients.
 * Destinations can be:
 * - @handles (e.g., "@alice")
 * - Email addresses (e.g., "bob@example.com")
 * - Webhook URLs (e.g., "https://webhook.example.com")
 */

import type { Storage, JournalEntry, User } from './storage.js';
import type { NotificationService } from './notifications.js';

// ═══════════════════════════════════════════════════════════════
// DESTINATION TYPES
// ═══════════════════════════════════════════════════════════════

export type Destination =
  | { type: 'handle'; handle: string; user?: User }
  | { type: 'email'; email: string; user?: User }
  | { type: 'webhook'; url: string };

// ═══════════════════════════════════════════════════════════════
// DESTINATION PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a single destination string into a typed Destination
 *
 * @param dest - The destination string (e.g., "@alice", "bob@example.com", "https://...")
 * @returns Parsed Destination object
 */
export function parseDestination(dest: string): Destination {
  const trimmed = dest.trim();

  // Handle: starts with @
  if (trimmed.startsWith('@')) {
    const handle = trimmed.slice(1).toLowerCase();
    return { type: 'handle', handle };
  }

  // Webhook URL: starts with http:// or https://
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { type: 'webhook', url: trimmed };
  }

  // Email: contains @ but doesn't start with it (and isn't a URL)
  if (trimmed.includes('@') && !trimmed.startsWith('@')) {
    return { type: 'email', email: trimmed.toLowerCase() };
  }

  // Default: treat as handle without @ prefix
  return { type: 'handle', handle: trimmed.toLowerCase() };
}

/**
 * Parse multiple destination strings
 *
 * @param destinations - Array of destination strings
 * @returns Array of parsed Destination objects
 */
export function parseDestinations(destinations: string[]): Destination[] {
  return destinations.map(parseDestination);
}

// ═══════════════════════════════════════════════════════════════
// DESTINATION RESOLUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve destinations by looking up handles and emails in storage
 *
 * @param destinations - Array of destination strings
 * @param storage - Storage instance for user lookups
 * @returns Array of resolved Destination objects with user info attached
 */
export async function resolveDestinations(
  destinations: string[],
  storage: Storage
): Promise<Destination[]> {
  const parsed = parseDestinations(destinations);
  const resolved: Destination[] = [];

  for (const dest of parsed) {
    if (dest.type === 'handle') {
      // Look up user by handle
      const user = await storage.getUser(dest.handle);
      resolved.push({ ...dest, user: user || undefined });
    } else if (dest.type === 'email') {
      // Look up user by email
      const user = await storage.getUserByEmail(dest.email);
      resolved.push({ ...dest, user: user || undefined });
    } else {
      // Webhooks don't need resolution
      resolved.push(dest);
    }
  }

  return resolved;
}

// ═══════════════════════════════════════════════════════════════
// SSRF PREVENTION
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a URL points to internal/private IP ranges
 */
export function isInternalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // Block private IP ranges
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      // 10.x.x.x
      if (a === 10) return true;
      // 172.16.x.x - 172.31.x.x
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.x.x
      if (a === 192 && b === 168) return true;
      // 127.x.x.x loopback
      if (a === 127) return true;
      // 169.254.x.x link-local
      if (a === 169 && b === 254) return true;
    }

    return false;
  } catch {
    return true; // Invalid URL = blocked
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK DELIVERY
// ═══════════════════════════════════════════════════════════════

/**
 * Webhook payload sent when an entry addresses a webhook URL.
 *
 * Example payload:
 * ```json
 * {
 *   "event": "entry.addressed",
 *   "entryId": "en_abc123def456",
 *   "author": {
 *     "handle": "alice",
 *     "pseudonym": "Quiet Feather#79c30b"
 *   },
 *   "content": "Deploy complete for v2.3.1",
 *   "timestamp": 1738512000000,
 *   "visibility": "public",
 *   "to": ["@bob", "https://webhook.example.com/notify"],
 *   "inReplyTo": null,
 *   "url": "https://hermes.ing/e/en_abc123def456"
 * }
 * ```
 */
export interface WebhookPayload {
  /** Event type (always "entry.addressed" for now) */
  event: 'entry.addressed';
  /** Unique entry ID */
  entryId: string;
  /** Author information */
  author: {
    /** Handle without @ prefix, or null if unclaimed */
    handle: string | null;
    /** Pseudonym (always present) */
    pseudonym: string;
  };
  /** Entry content (full text) */
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** ISO 8601 timestamp for convenience */
  timestampISO: string;
  /** Visibility level */
  visibility: 'public' | 'private' | 'ai-only';
  /** All destinations this entry was addressed to */
  to: string[];
  /** Parent entry ID if this is a reply, null otherwise */
  inReplyTo: string | null;
  /** Permalink to the entry */
  url: string;
}

/**
 * Deliver entry to a webhook URL
 *
 * @param url - Webhook URL
 * @param entry - The entry to deliver
 * @param baseUrl - Base URL for permalinks (e.g., "https://hermes.ing")
 * @param headers - Optional custom headers
 * @returns Success status and any error message
 */
export async function deliverWebhook(
  url: string,
  entry: JournalEntry,
  baseUrl: string,
  headers?: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  // SSRF prevention
  if (isInternalUrl(url)) {
    return { success: false, error: 'Internal URLs are blocked for security' };
  }

  const payload: WebhookPayload = {
    event: 'entry.addressed',
    entryId: entry.id,
    author: {
      handle: entry.handle || null,
      pseudonym: entry.pseudonym,
    },
    content: entry.content,
    timestamp: entry.timestamp,
    timestampISO: new Date(entry.timestamp).toISOString(),
    visibility: entry.visibility || 'public',
    to: entry.to || [],
    inReplyTo: entry.inReplyTo || null,
    url: `${baseUrl}/e/${entry.id}`,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Hermes/1.0',
        ...(headers || {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ═══════════════════════════════════════════════════════════════
// ENTRY DELIVERY
// ═══════════════════════════════════════════════════════════════

export interface DeliveryResult {
  destination: string;
  type: 'handle' | 'email' | 'webhook';
  success: boolean;
  error?: string;
}

export interface DeliveryConfig {
  storage: Storage;
  notificationService: NotificationService;
  emailClient?: {
    send(params: { from: string; to: string; subject: string; html: string }): Promise<void>;
  };
  fromEmail: string;
  baseUrl: string;
}

/**
 * Deliver an entry to all destinations in its `to` array
 *
 * @param entry - The entry to deliver
 * @param config - Configuration for delivery (storage, notification service, etc.)
 * @returns Array of delivery results
 */
export async function deliverEntry(
  entry: JournalEntry,
  config: DeliveryConfig
): Promise<DeliveryResult[]> {
  if (!entry.to || entry.to.length === 0) {
    return [];
  }

  const { storage, notificationService, emailClient, fromEmail, baseUrl } = config;
  const results: DeliveryResult[] = [];

  // Resolve destinations
  const destinations = await resolveDestinations(entry.to, storage);
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;

  for (let i = 0; i < destinations.length; i++) {
    const dest = destinations[i];
    const destString = entry.to[i];

    try {
      if (dest.type === 'handle') {
        // Notify user via in-app notification (and email if configured)
        if (dest.user) {
          await notificationService.notifyAddressedEntry?.(entry, dest.user);
          results.push({ destination: destString, type: 'handle', success: true });
        } else {
          results.push({ destination: destString, type: 'handle', success: false, error: 'User not found' });
        }
      } else if (dest.type === 'email') {
        // Send email directly
        if (emailClient) {
          // If email resolves to a user, notify them too
          if (dest.user) {
            await notificationService.notifyAddressedEntry?.(entry, dest.user);
          }

          // Send direct email
          await emailClient.send({
            from: `Hermes <${fromEmail}>`,
            to: dest.email,
            subject: `${author} sent you a message on Hermes`,
            html: renderAddressedEntryEmail(entry, author, baseUrl),
          });
          results.push({ destination: destString, type: 'email', success: true });
        } else {
          results.push({ destination: destString, type: 'email', success: false, error: 'Email not configured' });
        }
      } else if (dest.type === 'webhook') {
        // POST to webhook
        const result = await deliverWebhook(dest.url, entry, baseUrl);
        results.push({ destination: destString, type: 'webhook', ...result });
      }
    } catch (err) {
      results.push({
        destination: destString,
        type: dest.type,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════════

/**
 * Render HTML email for an addressed entry
 */
function renderAddressedEntryEmail(entry: JournalEntry, author: string, baseUrl: string): string {
  const contentPreview = entry.content.length > 500
    ? entry.content.slice(0, 500) + '...'
    : entry.content;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { color: #6b6b6b; font-size: 14px; margin-bottom: 20px; }
    .content { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .author { font-weight: bold; color: #7c5cbf; margin-bottom: 10px; }
    .footer { font-size: 12px; color: #999; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
    .btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="header">You received a message on Hermes</div>

  <div class="content">
    <div class="author">${author} wrote:</div>
    <p>${contentPreview}</p>
  </div>

  <a href="${baseUrl}/e/${entry.id}" class="btn">View on Hermes</a>

  <div class="footer">
    <p>You're receiving this because someone addressed you in a Hermes entry.</p>
  </div>
</body>
</html>
  `.trim();
}

// ═══════════════════════════════════════════════════════════════
// VISIBILITY HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Determine default visibility based on addressing
 *
 * @param to - Array of destinations (or undefined)
 * @param inReplyTo - Parent entry ID (or undefined)
 * @returns Default visibility value
 */
export function getDefaultVisibility(
  to?: string[],
  inReplyTo?: string
): 'public' | 'private' | 'ai-only' {
  // Has `to` but no `inReplyTo` -> private (DM)
  if (to && to.length > 0 && !inReplyTo) {
    return 'private';
  }
  // Has `inReplyTo` -> public (reply in thread)
  // Neither -> public (regular post)
  return 'public';
}

/**
 * Check if a user can view an entry based on visibility rules
 *
 * @param entry - The entry to check
 * @param userHandle - The user's handle (without @)
 * @param userEmail - The user's email (optional)
 * @param isAuthor - Whether the user is the entry's author
 * @returns Whether the user can view the entry
 */
export function canViewEntry(
  entry: JournalEntry,
  userHandle?: string,
  userEmail?: string,
  isAuthor?: boolean
): boolean {
  // Authors can always see their own entries
  if (isAuthor) return true;

  // Public entries are visible to everyone
  if (!entry.visibility || entry.visibility === 'public') return true;

  // AI-only: everyone can see (but content is stripped for non-authors)
  if (entry.visibility === 'ai-only') return true;

  // Private: only visible to recipients
  if (entry.visibility === 'private') {
    if (!entry.to || entry.to.length === 0) return false;

    // Check if user is a recipient
    if (userHandle) {
      if (entry.to.includes(`@${userHandle}`) || entry.to.includes(userHandle)) {
        return true;
      }
    }
    if (userEmail) {
      if (entry.to.some(dest => dest.toLowerCase() === userEmail.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  return true;
}

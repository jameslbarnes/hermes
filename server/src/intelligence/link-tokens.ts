/**
 * Platform Link Token Store
 *
 * Short-lived codes that tie together a platform DM (which proves platform
 * ownership) with an MCP call (which proves Router key ownership).
 *
 * Flow:
 *   1. User DMs bot on Matrix: "link"
 *   2. Bot generates a code, stores { code → { platform, platformUserId } }
 *   3. User calls router_link_platform(code) via MCP (auth'd with Router key)
 *   4. Server retrieves the platform info by code, links it to the user's handle
 */

export interface LinkToken {
  platform: string;          // "matrix", "telegram", etc.
  platformUserId: string;    // "@alice:matrix.org", "12345", etc.
  createdAt: number;
  expiresAt: number;
}

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const tokens = new Map<string, LinkToken>();

/**
 * Generate a new link token for a platform user.
 * Returns the code they should share with their Router-connected client.
 */
export function generateLinkToken(platform: string, platformUserId: string): string {
  // Clean up expired tokens
  pruneExpired();

  // Simple readable code: ROUTER-<6 chars>
  const code = `ROUTER-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const now = Date.now();

  tokens.set(code, {
    platform,
    platformUserId,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  });

  return code;
}

/**
 * Redeem a link token. Returns the platform info if valid, or null.
 * Removes the token after successful redemption (one-time use).
 */
export function redeemLinkToken(code: string): LinkToken | null {
  const token = tokens.get(code);
  if (!token) return null;

  if (Date.now() > token.expiresAt) {
    tokens.delete(code);
    return null;
  }

  tokens.delete(code); // One-time use
  return token;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [code, token] of tokens.entries()) {
    if (now > token.expiresAt) tokens.delete(code);
  }
}

/** For testing */
export function clearAllTokens(): void {
  tokens.clear();
}

/** For monitoring */
export function getActiveTokenCount(): number {
  pruneExpired();
  return tokens.size;
}

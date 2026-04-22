import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateLinkToken,
  redeemLinkToken,
  clearAllTokens,
  getActiveTokenCount,
} from './link-tokens.js';

describe('link-tokens', () => {
  beforeEach(() => {
    clearAllTokens();
  });

  it('generates a unique code for each call', () => {
    const c1 = generateLinkToken('matrix', '@alice:matrix.org');
    const c2 = generateLinkToken('matrix', '@alice:matrix.org');
    expect(c1).not.toBe(c2);
    expect(c1).toMatch(/^ROUTER-/);
  });

  it('redeems a valid code and returns platform info', () => {
    const code = generateLinkToken('matrix', '@bob:matrix.org');
    const result = redeemLinkToken(code);
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('matrix');
    expect(result!.platformUserId).toBe('@bob:matrix.org');
  });

  it('is one-time use — redeeming twice returns null', () => {
    const code = generateLinkToken('telegram', '123456');
    expect(redeemLinkToken(code)).not.toBeNull();
    expect(redeemLinkToken(code)).toBeNull();
  });

  it('returns null for unknown codes', () => {
    expect(redeemLinkToken('ROUTER-NOPE12')).toBeNull();
  });

  it('handles multiple platforms independently', () => {
    const mat = generateLinkToken('matrix', '@alice:matrix.org');
    const tel = generateLinkToken('telegram', '12345');

    const r1 = redeemLinkToken(mat);
    expect(r1!.platform).toBe('matrix');

    const r2 = redeemLinkToken(tel);
    expect(r2!.platform).toBe('telegram');
  });

  it('counts active tokens', () => {
    expect(getActiveTokenCount()).toBe(0);
    generateLinkToken('matrix', '@a:b');
    generateLinkToken('matrix', '@c:d');
    expect(getActiveTokenCount()).toBe(2);
  });
});

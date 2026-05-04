import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerPlatform,
  getPlatform,
  getAllPlatforms,
  hasPlatform,
  startAllPlatforms,
  stopAllPlatforms,
} from './registry.js';
import type { Platform } from './types.js';

function makeFakePlatform(name: string): Platform {
  return {
    name,
    maxMessageLength: 4096,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => 'msg-id'),
    sendDM: vi.fn(async () => 'msg-id'),
    createRoom: vi.fn(async () => ({ id: 'room', type: 'group' as const, platform: name })),
    inviteToRoom: vi.fn(async () => {}),
    removeFromRoom: vi.fn(async () => {}),
    setRoomTopic: vi.fn(async () => {}),
    setUserRole: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    resolveRouterHandle: vi.fn(async () => null),
    resolvePlatformId: vi.fn(async () => null),
    formatContent: (s: string) => s,
  };
}

describe('Platform Registry', () => {
  beforeEach(async () => {
    // Clear any previously registered platforms
    const existing = getAllPlatforms();
    for (const p of existing) {
      await p.stop();
    }
    // Registry uses a module-level Map; we just re-register to overwrite
  });

  it('registers a platform and retrieves it by name', () => {
    const fake = makeFakePlatform('test-matrix');
    registerPlatform(fake);

    const retrieved = getPlatform('test-matrix');
    expect(retrieved).toBe(fake);
  });

  it('reports whether a platform is registered', () => {
    registerPlatform(makeFakePlatform('test-has'));
    expect(hasPlatform('test-has')).toBe(true);
    expect(hasPlatform('does-not-exist')).toBe(false);
  });

  it('returns undefined for unknown platforms', () => {
    expect(getPlatform('nonexistent-platform-xyz')).toBeUndefined();
  });

  it('returns all registered platforms', () => {
    const p1 = makeFakePlatform('test-all-1');
    const p2 = makeFakePlatform('test-all-2');
    registerPlatform(p1);
    registerPlatform(p2);

    const all = getAllPlatforms();
    expect(all).toContain(p1);
    expect(all).toContain(p2);
  });

  it('startAllPlatforms calls start() on every platform', async () => {
    const p1 = makeFakePlatform('test-start-1');
    const p2 = makeFakePlatform('test-start-2');
    registerPlatform(p1);
    registerPlatform(p2);

    await startAllPlatforms();

    expect(p1.start).toHaveBeenCalled();
    expect(p2.start).toHaveBeenCalled();
  });

  it('stopAllPlatforms calls stop() on every platform', async () => {
    const p1 = makeFakePlatform('test-stop-1');
    registerPlatform(p1);

    await stopAllPlatforms();
    expect(p1.stop).toHaveBeenCalled();
  });

  it('overwrites an existing platform when re-registered', () => {
    const original = makeFakePlatform('test-overwrite');
    const replacement = makeFakePlatform('test-overwrite');
    registerPlatform(original);
    registerPlatform(replacement);

    expect(getPlatform('test-overwrite')).toBe(replacement);
  });

  it('continues starting other platforms if one fails', async () => {
    const failing = makeFakePlatform('test-fail');
    (failing.start as any) = vi.fn(async () => { throw new Error('boom'); });
    const good = makeFakePlatform('test-good');

    registerPlatform(failing);
    registerPlatform(good);

    // Suppress expected console.error
    const origError = console.error;
    console.error = vi.fn();

    await expect(startAllPlatforms()).resolves.not.toThrow();

    console.error = origError;
    expect(good.start).toHaveBeenCalled();
  });
});

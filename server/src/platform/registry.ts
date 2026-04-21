/**
 * Platform Registry
 *
 * Central registry for all communications platform plugins.
 * Replaces platform-specific globals like getTelegramBot().
 */

import type { Platform } from './types.js';

const platforms = new Map<string, Platform>();

export function registerPlatform(platform: Platform): void {
  if (platforms.has(platform.name)) {
    console.warn(`[Platform] Overwriting existing platform: ${platform.name}`);
  }
  platforms.set(platform.name, platform);
  console.log(`[Platform] Registered: ${platform.name}`);
}

export function getPlatform(name: string): Platform | undefined {
  return platforms.get(name);
}

export function getAllPlatforms(): Platform[] {
  return Array.from(platforms.values());
}

export function hasPlatform(name: string): boolean {
  return platforms.has(name);
}

export async function startAllPlatforms(): Promise<void> {
  for (const platform of platforms.values()) {
    try {
      await platform.start();
      console.log(`[Platform] Started: ${platform.name}`);
    } catch (err) {
      console.error(`[Platform] Failed to start ${platform.name}:`, err);
    }
  }
}

export async function stopAllPlatforms(): Promise<void> {
  for (const platform of platforms.values()) {
    try {
      await platform.stop();
      console.log(`[Platform] Stopped: ${platform.name}`);
    } catch (err) {
      console.error(`[Platform] Failed to stop ${platform.name}:`, err);
    }
  }
}

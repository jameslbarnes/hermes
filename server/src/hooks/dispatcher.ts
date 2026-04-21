/**
 * Hook Dispatcher
 *
 * Routes events to registered hook handlers. Replaces the agent's
 * poll loop with synchronous in-process dispatch.
 *
 * The event queue (events.ts) calls the dispatcher after pushing
 * each event. Handlers run in priority order, sequentially.
 */

import type { HermesEvent } from '../events.js';
import type { Storage } from '../storage.js';
import type { HookRegistration, HookTrigger, HookContext } from './types.js';
import { getAllPlatforms } from '../platform/registry.js';

export class HookDispatcher {
  private hooks: HookRegistration[] = [];
  private storage: Storage | null = null;

  setStorage(storage: Storage): void {
    this.storage = storage;
  }

  register(hook: HookRegistration): void {
    this.hooks.push(hook);
    // Re-sort by priority
    this.hooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    console.log(`[Hooks] Registered: ${hook.id} → [${hook.triggers.join(', ')}]`);
  }

  unregister(id: string): void {
    this.hooks = this.hooks.filter(h => h.id !== id);
  }

  async dispatch(event: HermesEvent): Promise<void> {
    const trigger = event.type as HookTrigger;
    const matching = this.hooks.filter(h => h.triggers.includes(trigger));

    if (matching.length === 0) return;

    const ctx: HookContext = {
      trigger,
      event,
      storage: this.storage!,
      platforms: getAllPlatforms(),
    };

    for (const hook of matching) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        console.error(`[Hooks] Handler "${hook.id}" failed for ${event.type}:`, err);
      }
    }
  }

  getRegisteredHooks(): { id: string; triggers: HookTrigger[] }[] {
    return this.hooks.map(h => ({ id: h.id, triggers: h.triggers }));
  }
}

// Singleton
let instance: HookDispatcher | null = null;

export function getDispatcher(): HookDispatcher {
  if (!instance) {
    instance = new HookDispatcher();
  }
  return instance;
}

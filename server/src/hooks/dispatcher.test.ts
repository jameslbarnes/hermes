import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookDispatcher } from './dispatcher.js';
import { MemoryStorage } from '../storage.js';
import type { RouterEvent } from '../events.js';

function makeEvent(type: RouterEvent['type'], data: Record<string, any> = {}): RouterEvent {
  return { id: 1, type, timestamp: Date.now(), data };
}

describe('HookDispatcher', () => {
  let dispatcher: HookDispatcher;
  let storage: MemoryStorage;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
    storage = new MemoryStorage();
    dispatcher.setStorage(storage);
  });

  it('calls handlers registered for a matching trigger', async () => {
    const handler = vi.fn();
    dispatcher.register({
      id: 'test:handler',
      triggers: ['entry_published'],
      handler,
    });

    await dispatcher.dispatch(makeEvent('entry_published', { entry_id: 'abc' }));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].event.data.entry_id).toBe('abc');
  });

  it('does not call handlers for non-matching triggers', async () => {
    const handler = vi.fn();
    dispatcher.register({
      id: 'test:handler',
      triggers: ['entry_published'],
      handler,
    });

    await dispatcher.dispatch(makeEvent('platform_message'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs handlers in priority order (lower = first)', async () => {
    const calls: string[] = [];
    dispatcher.register({
      id: 'second',
      triggers: ['entry_published'],
      handler: async () => { calls.push('second'); },
      priority: 100,
    });
    dispatcher.register({
      id: 'first',
      triggers: ['entry_published'],
      handler: async () => { calls.push('first'); },
      priority: 10,
    });

    await dispatcher.dispatch(makeEvent('entry_published'));
    expect(calls).toEqual(['first', 'second']);
  });

  it('continues to other handlers if one throws', async () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();

    dispatcher.register({ id: 'bad', triggers: ['entry_published'], handler: bad });
    dispatcher.register({ id: 'good', triggers: ['entry_published'], handler: good });

    // Suppress expected console.error
    const origError = console.error;
    console.error = vi.fn();

    await dispatcher.dispatch(makeEvent('entry_published'));

    console.error = origError;
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('unregisters handlers by id', async () => {
    const handler = vi.fn();
    dispatcher.register({
      id: 'test:handler',
      triggers: ['entry_published'],
      handler,
    });

    dispatcher.unregister('test:handler');
    await dispatcher.dispatch(makeEvent('entry_published'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles no registered handlers gracefully', async () => {
    await expect(
      dispatcher.dispatch(makeEvent('entry_published'))
    ).resolves.not.toThrow();
  });

  it('supports handlers registered for multiple triggers', async () => {
    const handler = vi.fn();
    dispatcher.register({
      id: 'multi',
      triggers: ['entry_staged', 'entry_published'],
      handler,
    });

    await dispatcher.dispatch(makeEvent('entry_staged'));
    await dispatcher.dispatch(makeEvent('entry_published'));
    await dispatcher.dispatch(makeEvent('platform_message'));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('passes storage and platforms in the context', async () => {
    const handler = vi.fn();
    dispatcher.register({
      id: 'ctx',
      triggers: ['entry_published'],
      handler,
    });

    await dispatcher.dispatch(makeEvent('entry_published'));

    const ctx = handler.mock.calls[0][0];
    expect(ctx.storage).toBe(storage);
    expect(Array.isArray(ctx.platforms)).toBe(true);
  });
});

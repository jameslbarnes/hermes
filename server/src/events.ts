/**
 * Event queue for the Hermes agent.
 *
 * The server pushes events (entry staged, entry published, chat message,
 * mention, etc.) and the agent polls them via the hermes_poll_events MCP tool.
 * Events are held in memory with a rolling window.
 */

export type EventType =
  | 'entry_staged'
  | 'entry_published'
  | 'entry_held'
  | 'platform_message'
  | 'platform_mention'
  | 'platform_reaction';

export interface HermesEvent {
  id: number;
  type: EventType;
  timestamp: number;
  data: Record<string, any>;
}

const MAX_EVENTS = 1000;

let nextId = 1;
const events: HermesEvent[] = [];

// Hook dispatcher integration — set by server startup
type DispatchFn = (event: HermesEvent) => Promise<void>;
let dispatchToHooks: DispatchFn | null = null;

/**
 * Set the hook dispatcher callback. Called once during server startup.
 */
export function setDispatcher(fn: DispatchFn): void {
  dispatchToHooks = fn;
}

/**
 * Push a new event to the queue.
 */
export function pushEvent(type: EventType, data: Record<string, any>): HermesEvent {
  const event: HermesEvent = {
    id: nextId++,
    type,
    timestamp: Date.now(),
    data,
  };
  events.push(event);

  // Trim old events
  while (events.length > MAX_EVENTS) {
    events.shift();
  }

  // Dispatch to hook handlers (non-blocking)
  if (dispatchToHooks) {
    dispatchToHooks(event).catch(err => {
      console.error('[Events] Hook dispatch failed:', err);
    });
  }

  return event;
}

/**
 * Get events since a cursor (event ID). Returns events with id > cursor.
 * If cursor is 0 or omitted, returns recent events (last 50).
 */
export function getEventsSince(cursor = 0, limit = 50): HermesEvent[] {
  if (cursor === 0) {
    return events.slice(-limit);
  }
  return events.filter(e => e.id > cursor).slice(0, limit);
}

/**
 * Get the current cursor (latest event ID). Useful for initial sync.
 */
export function getLatestCursor(): number {
  return events.length > 0 ? events[events.length - 1].id : 0;
}

/**
 * Reset the event queue (for testing).
 */
export function resetEvents(): void {
  events.length = 0;
  nextId = 1;
}

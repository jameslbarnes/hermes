/**
 * Ring buffer of recent group chat messages.
 * Stores the last N messages for context when evaluating interjections.
 */

import type { BufferedMessage } from './types.js';

const DEFAULT_CAPACITY = 100;

export interface ConversationHeat {
  /** Messages in the last N minutes. */
  recentCount: number;
  /** Unique senders in the last N minutes. */
  uniqueSenders: number;
  /** Average message length in the last N minutes. */
  avgLength: number;
  /** Whether this looks like an active, substantive conversation. */
  isHot: boolean;
}

export class MessageBuffer {
  private messages: BufferedMessage[] = [];
  private capacity: number;
  private messagesSinceLastCheck = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** Add a message to the buffer. Drops oldest if at capacity. */
  push(msg: BufferedMessage): void {
    if (this.messages.length >= this.capacity) {
      this.messages.shift();
    }
    this.messages.push(msg);
    this.messagesSinceLastCheck++;
  }

  /** Get the last N messages (oldest first). */
  recent(n: number): BufferedMessage[] {
    return this.messages.slice(-n);
  }

  /** Get the most recent message, or null if empty. */
  latest(): BufferedMessage | null {
    return this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
  }

  /** Format the last N messages as a readable string for Claude's context. */
  formatForContext(n: number): string {
    const msgs = this.recent(n);
    if (msgs.length === 0) return '(no recent messages)';
    return msgs
      .map((m) => {
        const time = new Date(m.timestamp).toISOString().slice(11, 16); // HH:MM
        return `[${time}] ${m.senderName}: ${m.text}`;
      })
      .join('\n');
  }

  /**
   * Measure how "hot" the conversation is over a recent time window.
   * Hot = multiple people exchanging substantive messages quickly.
   */
  measureHeat(windowMs = 10 * 60 * 1000, now = Date.now()): ConversationHeat {
    const cutoff = now - windowMs;
    const recent = this.messages.filter((m) => m.timestamp > cutoff);

    if (recent.length === 0) {
      return { recentCount: 0, uniqueSenders: 0, avgLength: 0, isHot: false };
    }

    const senders = new Set(recent.map((m) => m.senderName));
    const totalLength = recent.reduce((sum, m) => sum + m.text.length, 0);
    const avgLength = totalLength / recent.length;

    // Hot = 3+ people, 8+ messages, avg message > 40 chars in the window
    const isHot = senders.size >= 3 && recent.length >= 8 && avgLength > 40;

    return {
      recentCount: recent.length,
      uniqueSenders: senders.size,
      avgLength: Math.round(avgLength),
      isHot,
    };
  }

  /** Number of messages added since the last call to resetCheckCounter(). */
  get messagesSinceCheck(): number {
    return this.messagesSinceLastCheck;
  }

  /** Reset the "messages since last check" counter (called after an interjection eval). */
  resetCheckCounter(): void {
    this.messagesSinceLastCheck = 0;
  }

  /** Total messages currently in the buffer. */
  get size(): number {
    return this.messages.length;
  }

  /** Clear all messages. */
  clear(): void {
    this.messages = [];
    this.messagesSinceLastCheck = 0;
  }
}

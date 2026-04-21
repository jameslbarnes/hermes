/**
 * Conversation Heat Detection
 *
 * Measures how "active" a conversation is based on message frequency,
 * sender diversity, and message substance. Used to decide when to
 * write back to the notebook or evaluate for sparks.
 *
 * Extracted from telegram/buffer.ts — already platform-agnostic.
 */

export interface BufferedMessage {
  text: string;
  senderName: string;
  senderId?: string;
  timestamp: number;
  platform?: string;
  roomId?: string;
}

export interface ConversationHeat {
  recentCount: number;
  uniqueSenders: number;
  avgLength: number;
  isHot: boolean;
}

const DEFAULT_CAPACITY = 100;

export class MessageBuffer {
  private messages: BufferedMessage[] = [];
  private capacity: number;
  private messagesSinceLastCheck = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  push(msg: BufferedMessage): void {
    if (this.messages.length >= this.capacity) {
      this.messages.shift();
    }
    this.messages.push(msg);
    this.messagesSinceLastCheck++;
  }

  recent(n: number): BufferedMessage[] {
    return this.messages.slice(-n);
  }

  latest(): BufferedMessage | null {
    return this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
  }

  formatForContext(n: number): string {
    const msgs = this.recent(n);
    if (msgs.length === 0) return '(no recent messages)';
    return msgs
      .map((m) => {
        const time = new Date(m.timestamp).toISOString().slice(11, 16);
        return `[${time}] ${m.senderName}: ${m.text}`;
      })
      .join('\n');
  }

  /**
   * Measure how "hot" the conversation is.
   * Hot = 3+ unique senders, 8+ messages, avg length > 40 chars
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

    const isHot = senders.size >= 3 && recent.length >= 8 && avgLength > 40;

    return {
      recentCount: recent.length,
      uniqueSenders: senders.size,
      avgLength: Math.round(avgLength),
      isHot,
    };
  }

  get messagesSinceCheck(): number {
    return this.messagesSinceLastCheck;
  }

  resetCheckCounter(): void {
    this.messagesSinceLastCheck = 0;
  }

  get size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
    this.messagesSinceLastCheck = 0;
  }
}

/**
 * Manages message buffers per room across all platforms.
 */
export class RoomBufferManager {
  private buffers = new Map<string, MessageBuffer>();

  getBuffer(roomId: string): MessageBuffer {
    let buffer = this.buffers.get(roomId);
    if (!buffer) {
      buffer = new MessageBuffer();
      this.buffers.set(roomId, buffer);
    }
    return buffer;
  }

  getAllHotRooms(windowMs?: number): { roomId: string; heat: ConversationHeat }[] {
    const hot: { roomId: string; heat: ConversationHeat }[] = [];
    for (const [roomId, buffer] of this.buffers) {
      const heat = buffer.measureHeat(windowMs);
      if (heat.isHot) {
        hot.push({ roomId, heat });
      }
    }
    return hot;
  }
}

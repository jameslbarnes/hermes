/**
 * Shared types for the Telegram bot module.
 */

import type { Storage, JournalEntry } from '../storage.js';

/** A buffered message from the watched group chat. */
export interface BufferedMessage {
  senderName: string;
  text: string;
  timestamp: number;
  messageId: number;
}

/** Configuration for the Telegram bot. */
export interface TelegramConfig {
  botToken: string;
  channelId: string;
  anthropicApiKey?: string;
  baseUrl: string;
  /** Group chat ID to watch for proactive features. */
  groupChatId?: string;
  /** Bot's Hermes secret key (auto-generated if unset). */
  botSecretKey?: string;
  /** Bot's @handle in the notebook. */
  botHandle?: string;
  /** 'score' = Claude-filtered, 'all' = post everything. */
  postMode?: 'score' | 'all';
  /** Max proactive messages per hour. */
  maxPerHour?: number;
  /** Cooldown between proactive posts in ms. */
  cooldownMs?: number;
}

/** Runtime context passed to sub-modules. */
export interface BotContext {
  config: TelegramConfig;
  storage: Storage;
  /** Send a message to the channel (MarkdownV2). */
  sendToChannel: (text: string) => Promise<void>;
  /** Send a plain text message to the group chat. */
  sendToGroup: (text: string, replyToMessageId?: number) => Promise<void>;
  /** The bot's Hermes pseudonym. */
  botPseudonym: string;
  /** The bot's Hermes handle. */
  botHandle: string;
}

/** An entry that was recently posted to the channel, for dedup and context. */
export interface PostedEntry {
  entryId: string;
  contentSnippet: string;
  author: string;
  hook?: string;
  timestamp: number;
}

/**
 * Communications Platform Plugin Interface
 *
 * Every platform (Telegram, Matrix, Discord, Slack, etc.) implements this
 * interface. The agent and hook system interact with platforms exclusively
 * through this abstraction.
 */

export interface PlatformIdentity {
  platformUserId: string;
  platformUsername?: string;
  routerHandle?: string;
}

export type RoomType = 'dm' | 'group' | 'channel';

export interface PlatformRoom {
  id: string;
  name?: string;
  type: RoomType;
  topic?: string;
  members?: PlatformIdentity[];
  platform: string;
}

export interface PlatformMessage {
  id: string;
  roomId: string;
  sender: PlatformIdentity;
  text: string;
  timestamp: number;
  replyToMessageId?: string;
  platform: string;
}

export interface SendMessageOptions {
  replyTo?: string;
  format?: 'plain' | 'markdown';
}

export interface CreateRoomOptions {
  type: RoomType;
  invite?: string[];    // Router handles to invite
  topic?: string;
  encrypted?: boolean;
  attachToSpace?: boolean;
}

export interface Platform {
  readonly name: string;

  // ── Lifecycle ──────────────────────────────────────────────
  start(): Promise<void>;
  stop(): Promise<void>;

  // ── Messaging ──────────────────────────────────────────────
  sendMessage(roomId: string, text: string, opts?: SendMessageOptions): Promise<string>;
  sendDM(userId: string, text: string, opts?: SendMessageOptions): Promise<string>;

  // ── Room Management ────────────────────────────────────────
  createRoom(name: string, opts: CreateRoomOptions): Promise<PlatformRoom>;
  inviteToRoom(roomId: string, userId: string): Promise<void>;
  removeFromRoom(roomId: string, userId: string): Promise<void>;
  setRoomTopic(roomId: string, topic: string): Promise<void>;
  setUserRole(roomId: string, userId: string, role: 'admin' | 'moderator' | 'member'): Promise<void>;
  deleteMessage(roomId: string, messageId: string): Promise<void>;

  // ── Identity ───────────────────────────────────────────────
  /** Given a platform-native user ID, return the Router handle (if known) */
  resolveRouterHandle(platformUserId: string): Promise<string | null>;
  /** Given a Router handle, return the platform-native user ID (if known).
   *  Checks linkedAccounts in storage first, falls back to convention. */
  resolvePlatformId(routerHandle: string): Promise<string | null>;

  // ── Formatting ─────────────────────────────────────────────
  /** Convert markdown to platform-native format */
  formatContent(markdown: string): string;
  /** Platform's maximum message length in characters */
  readonly maxMessageLength: number;
}

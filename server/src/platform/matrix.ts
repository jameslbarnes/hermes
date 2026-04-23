/**
 * Matrix Platform Plugin with E2EE
 *
 * Implements the Platform interface using matrix-js-sdk with Rust crypto.
 * The bot authenticates with credentials derived from a Hermes secret key
 * and participates in encrypted rooms.
 *
 * Key lessons from Andrew's shape-rotator-matrix work:
 * - Crypto store must be persistent and created in-place (never copy)
 * - Trust relaxation: accept unverified devices or messages fail silently
 * - Send a wake message after joining encrypted rooms (Element withholds keys otherwise)
 * - Cross-signing requires password UIA
 */

import { createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  createClient,
  type MatrixClient,
  type ICreateClientOpts,
  type Room,
  type MatrixEvent,
  MatrixEventEvent,
  EventType,
  MsgType,
  RoomMemberEvent,
  ClientEvent,
  KnownMembership,
  Preset,
  Visibility,
} from 'matrix-js-sdk';
import type {
  Platform,
  PlatformRoom,
  PlatformMessage,
  PlatformIdentity,
  SendMessageOptions,
  CreateRoomOptions,
  RoomType,
} from './types.js';
import { pushEvent } from '../events.js';
import { SASVerificationManager } from './sas-verification.js';

// Polyfill IndexedDB for Node.js (required by matrix-sdk-crypto-wasm)
import 'fake-indexeddb/auto';
import {
  restoreCryptoStore,
  resetCryptoStoreSnapshot,
  startPersisting,
  flushCryptoStore,
  stopPersisting,
} from './crypto-store-persist.js';

export interface MatrixPlatformConfig {
  serverUrl: string;
  serverName: string;
  botSecretKey: string;
  botHandle: string;
  spaceRoomId?: string;
  registrationToken?: string;
  /** Signup wrapper URL (e.g. Shape Rotator's /signup/api). If set, registration
   *  uses this wrapper instead of the native Matrix registration endpoint. */
  signupUrl?: string;
  cryptoStoreName?: string;
  cryptoStorePassword?: string;
  baseUrl?: string;
  resolveLinkedPlatformId?: (platform: string, hermesHandle: string) => Promise<string | null>;
  resolveLinkedHermesHandle?: (platform: string, platformUserId: string) => Promise<string | null>;
}

// Custom Matrix event types for tight notebook integration
export const ROUTER_ENTRY_EVENT = 'com.router.entry';
export const ROUTER_SPARK_EVENT = 'com.router.spark';
export const ROUTER_DIGEST_EVENT = 'com.router.digest';
export const ROUTER_CHANNEL_STATE = 'com.router.channel';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isMatrixMention(params: {
  isDM: boolean;
  text: string;
  content: Record<string, any>;
  botUserId: string | null;
  botHandle: string;
}): boolean {
  const { isDM, text, content, botUserId, botHandle } = params;

  if (isDM) return true;

  const mentions = content['m.mentions'];
  const mentionedUserIds = Array.isArray(mentions?.user_ids) ? mentions.user_ids : [];
  if (botUserId && mentionedUserIds.includes(botUserId)) {
    return true;
  }

  const formattedBody = typeof content.formatted_body === 'string' ? content.formatted_body : '';
  if (botUserId && (formattedBody.includes(botUserId) || formattedBody.includes(encodeURIComponent(botUserId)))) {
    return true;
  }

  const plainMention = new RegExp(`(^|\\s|[<(])@${escapeRegExp(botHandle)}(?=$|\\s|[)>:.,!?])`, 'i');
  return plainMention.test(text);
}

export class MatrixPlatform implements Platform {
  readonly name = 'matrix';
  readonly maxMessageLength = 65536;

  private client: MatrixClient | null = null;
  private botUserId: string | null = null;
  private config: MatrixPlatformConfig;
  private channelRooms = new Map<string, string>();
  private entryEventMap = new Map<string, string>();
  private processedMessageEvents = new Set<string>();

  constructor(config: MatrixPlatformConfig) {
    this.config = config;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    // Load any persisted crypto snapshot BEFORE initializing Rust crypto.
    // This restores device keys, cross-signing, Olm/Megolm sessions across
    // restarts — without this, every deploy wipes the bot's identity.
    const snapshotPath = process.env.MATRIX_CRYPTO_SNAPSHOT_PATH || '/data/matrix-crypto-snapshot.json';

    // Escape hatch: MATRIX_FRESH_CRYPTO=1 wipes the snapshot + credentials at
    // every boot. MATRIX_FRESH_CRYPTO=once does it exactly once and records a
    // marker in /data. Use when the local crypto store has drifted from the
    // server's view (symptom: persistent m.mismatched_sas / MAC validation
    // failures even with a clean device list).
    const freshCryptoMode = process.env.MATRIX_FRESH_CRYPTO;
    if (freshCryptoMode === '1' || freshCryptoMode === 'once') {
      const credsPath = process.env.MATRIX_CREDS_PATH || '/data/matrix-credentials.json';
      const onceMarkerPath = process.env.MATRIX_FRESH_CRYPTO_ONCE_MARKER
        || `${dirname(snapshotPath)}/matrix-fresh-crypto.once`;
      const shouldReset = freshCryptoMode === '1' || !existsSync(onceMarkerPath);

      if (shouldReset) {
        for (const p of [snapshotPath, credsPath]) {
          if (existsSync(p)) {
            try {
              const { unlinkSync } = await import('fs');
              unlinkSync(p);
              console.log(`[Matrix] MATRIX_FRESH_CRYPTO=${freshCryptoMode} deleted ${p}`);
            } catch (err: any) {
              console.warn(`[Matrix] Failed to delete ${p}:`, err.message);
            }
          }
        }

        if (freshCryptoMode === 'once') {
          const dir = dirname(onceMarkerPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(onceMarkerPath, JSON.stringify({ reset_at: new Date().toISOString() }), 'utf8');
          console.log(`[Matrix] MATRIX_FRESH_CRYPTO=once marker written: ${onceMarkerPath}`);
        }
      } else {
        console.log(`[Matrix] MATRIX_FRESH_CRYPTO=once already consumed: ${onceMarkerPath}`);
      }
    }

    await restoreCryptoStore({ filePath: snapshotPath });

    const password = createHmac('sha256', this.config.botSecretKey)
      .update(`matrix:${this.config.serverName}`)
      .digest('base64url');

    const username = this.config.botHandle;

    // Credential persistence: without this, every restart calls /login and
    // gets a fresh device_id, causing:
    //  - a device graveyard on the server (one orphan per restart)
    //  - Element verification requests getting targeted at dead devices
    //  - the crypto snapshot becoming useless (wrong device context)
    const credsPath = process.env.MATRIX_CREDS_PATH || '/data/matrix-credentials.json';

    let accessToken: string;
    let userId: string;
    let deviceId: string;

    const existingCreds = this.loadCredentials(credsPath);
    if (existingCreds && await this.validateCredentials(existingCreds)) {
      console.log(`[Matrix] Reusing persisted credentials, device=${existingCreds.device_id}`);
      accessToken = existingCreds.access_token;
      userId = existingCreds.user_id;
      deviceId = existingCreds.device_id;
    } else {
      try {
        const fresh = await this.obtainFreshCredentials(username, password);
        accessToken = fresh.access_token;
        userId = fresh.user_id;
        deviceId = fresh.device_id;
        this.saveCredentials(credsPath, fresh);
        console.log(`[Matrix] Obtained fresh credentials, device=${deviceId}`);
      } catch (e: any) {
        throw new Error(`Matrix auth failed: ${e.message}`);
      }
    }

    this.botUserId = userId;

    // Crypto callbacks — getSecretStorageKey is called when SSSS needs to unlock
    // a secret. We derive keys from the bot's Hermes secret key.
    const stableSecret = this.config.botSecretKey;
    const cryptoCallbacks: any = {
      getSecretStorageKey: async ({ keys }: { keys: Record<string, any> }): Promise<[string, Uint8Array] | null> => {
        const keyIds = Object.keys(keys);
        if (keyIds.length === 0) return null;
        // For bootstrap flow — the recovery key was created from stableSecret.
        // Return the first key ID with a derived 32-byte key.
        const raw = new TextEncoder().encode(`router-ssss-${stableSecret}`);
        const hashed = new Uint8Array(32);
        for (let i = 0; i < 32; i++) hashed[i] = raw[i % raw.length] ^ (i * 31);
        return [keyIds[0], hashed];
      },
    };

    const clientOpts: ICreateClientOpts = {
      baseUrl: this.config.serverUrl,
      userId,
      deviceId,
      accessToken,
      cryptoCallbacks,
    };

    this.client = createClient(clientOpts);

    // Initialize Rust crypto
    try {
      const storeName = this.config.cryptoStoreName || `router-crypto-${this.config.botHandle}`;
      const cryptoInitOpts = {
        useIndexedDB: true,
        cryptoDatabasePrefix: storeName,
        storagePassword: this.config.cryptoStorePassword || `${userId}:${deviceId}`,
      };

      try {
        await this.client.initRustCrypto(cryptoInitOpts);
      } catch (err: any) {
        // Snapshots written by the old post-init restore path can be internally
        // inconsistent: the meta store decrypts, but encrypted records were
        // written under a different store cipher. The failed Rust open can keep
        // IndexedDB handles alive, so repair by quarantining the snapshot and
        // exiting. Docker/Phala restarts the service into a clean process.
        const message = err?.message || '';
        const isUnusableSnapshot =
          message.includes('failed to be decrypted')
          || message.includes('unpickling')
          || message.includes('pickle');
        if (!isUnusableSnapshot) throw err;

        console.warn(`[Matrix] Crypto store snapshot unusable, resetting before process restart: ${message}`);
        await resetCryptoStoreSnapshot(snapshotPath, storeName);
        console.warn('[Matrix] Exiting so rust-crypto restarts with clean IndexedDB handles');
        process.exit(1);
      }

      console.log('[Matrix] Rust crypto initialized');
      const ownKeys = await this.client.getCrypto()?.getOwnDeviceKeys();
      console.log(`[Matrix] Own device keys: device=${deviceId} ed25519=${ownKeys?.ed25519 || 'unavailable'}`);

      // Start periodic persistence so state survives the next restart
      startPersisting({ filePath: snapshotPath, flushIntervalMs: 30_000 });
      await flushCryptoStore();
    } catch (e: any) {
      console.warn('[Matrix] Crypto init failed, running without E2EE:', e.message);
    }

    // Set up event listeners (messages, invites)
    this.setupEventListeners();

    // Start syncing (must happen before cross-signing bootstrap so we can query our own keys)
    await this.client.startClient({ initialSyncLimit: 0 });

    // Install the hand-rolled SAS verification manager. Replaces the SDK's
    // broken VerificationRequest/Verifier high-level API which produces MACs
    // that Continuwuity rejects with m.mismatched_sas. Ports Andrew Miller's
    // sas_verification.py working implementation. Must happen AFTER
    // startClient (needs user/device/crypto to be populated).
    try {
      await SASVerificationManager.create(this.client);
    } catch (err: any) {
      console.warn('[Matrix] SAS manager init failed (non-fatal):', err.message);
    }

    // Bootstrap cross-signing and secret storage — makes the bot a first-class
    // Matrix citizen that Element clients trust like any other verified user.
    // This is a one-time operation; subsequent startups find existing keys.
    this.bootstrapCryptoIdentity(username, password).catch(err => {
      console.warn('[Matrix] Cross-signing bootstrap failed (non-fatal):', err.message);
    });

    // Delete orphan devices from prior restarts — before credential persistence
    // landed, every restart created a new device. Element caches all of them
    // and gets confused during verification (MAC verification mismatch), which
    // shows up as m.mismatched_sas cancels.
    //
    // MUST complete before start() returns, otherwise clients verifying the
    // bot right after boot will still see the ghost devices in their cached
    // device list and SAS MAC validation will fail against phantoms.
    try {
      await this.cleanupOrphanDevices(userId, deviceId, accessToken, username, password);
    } catch (err: any) {
      console.warn('[Matrix] Orphan device cleanup failed (non-fatal):', err.message);
    }

    console.log(`[Matrix] Authenticated as ${userId}, syncing...`);

    // Wait for first sync
    await new Promise<void>((resolve) => {
      this.client!.once(ClientEvent.Sync, (state: string) => {
        if (state === 'PREPARED' || state === 'SYNCING') {
          console.log('[Matrix] Initial sync complete');
          resolve();
        }
      });
    });
  }

  async stop(): Promise<void> {
    // Flush crypto state to disk before shutting down
    try {
      stopPersisting();
      await flushCryptoStore();
    } catch (err: any) {
      console.warn('[Matrix] Final crypto flush failed:', err.message);
    }
    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }
  }

  // ── Credential persistence ────────────────────────────────

  private loadCredentials(path: string): { access_token: string; user_id: string; device_id: string } | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  private saveCredentials(path: string, creds: { access_token: string; user_id: string; device_id: string }): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(creds), 'utf8');
  }

  /** Verify an access token is still valid by hitting /account/whoami. */
  private async validateCredentials(creds: { access_token: string; user_id: string; device_id: string }): Promise<boolean> {
    try {
      const resp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { 'Authorization': `Bearer ${creds.access_token}` },
      });
      if (!resp.ok) return false;
      const data = await resp.json() as any;
      return data.user_id === creds.user_id && data.device_id === creds.device_id;
    } catch {
      return false;
    }
  }

  /** Run the login / signup / register flow to get fresh credentials. */
  private async obtainFreshCredentials(username: string, password: string): Promise<{ access_token: string; user_id: string; device_id: string }> {
    const loginResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      }),
    });
    if (loginResp.ok) {
      const data = await loginResp.json() as any;
      return { access_token: data.access_token, user_id: data.user_id, device_id: data.device_id };
    }

    if (this.config.signupUrl && this.config.registrationToken) {
      const signupResp = await fetch(this.config.signupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: this.config.registrationToken,
          username,
          password,
        }),
      });
      const signupData = await signupResp.json() as any;
      if (!signupResp.ok) {
        throw new Error(`Signup wrapper failed: ${signupData.error || JSON.stringify(signupData)}`);
      }
      return { access_token: signupData.access_token, user_id: signupData.user_id, device_id: signupData.device_id };
    }

    if (!this.config.registrationToken) {
      throw new Error('Bot account does not exist and no registration token provided');
    }

    const initResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const initData = await initResp.json() as any;

    const regResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username, password,
        auth: {
          type: 'm.login.registration_token',
          token: this.config.registrationToken,
          session: initData.session,
        },
      }),
    });
    const regData = await regResp.json() as any;
    if (!regResp.ok) throw new Error(`Registration failed: ${regData.error}`);

    await fetch(`${this.config.serverUrl}/_matrix/client/v3/profile/${regData.user_id}/displayname`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${regData.access_token}` },
      body: JSON.stringify({ displayname: this.config.botHandle }),
    }).catch(() => {});

    return { access_token: regData.access_token, user_id: regData.user_id, device_id: regData.device_id };
  }

  /**
   * Delete all the bot's devices except the currently-active one.
   *
   * Uses POST /delete_devices with UIA password auth in a single call so the
   * server only charges one round-trip for the UIA dance.
   */
  private async cleanupOrphanDevices(
    userId: string,
    currentDeviceId: string,
    accessToken: string,
    username: string,
    password: string,
  ): Promise<void> {
    const listResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/devices`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      console.warn(`[Matrix] /devices list failed: ${listResp.status}`);
      return;
    }
    const listData = await listResp.json() as any;
    const orphanIds: string[] = (listData.devices || [])
      .map((d: any) => d.device_id)
      .filter((id: string) => id && id !== currentDeviceId);

    if (orphanIds.length === 0) {
      console.log('[Matrix] No orphan devices to clean up');
      return;
    }
    console.log(`[Matrix] Cleaning up ${orphanIds.length} orphan devices: ${orphanIds.join(',')}`);

    // Step 1: probe for UIA session
    const probe = await fetch(`${this.config.serverUrl}/_matrix/client/v3/delete_devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ devices: orphanIds }),
    });
    if (probe.ok) {
      console.log('[Matrix] Orphan devices deleted (no UIA required)');
      return;
    }
    const probeData = await probe.json() as any;
    if (probe.status !== 401 || !probeData.session) {
      console.warn(`[Matrix] /delete_devices unexpected response: ${probe.status} ${JSON.stringify(probeData)}`);
      return;
    }

    // Step 2: complete UIA with password
    const doDelete = await fetch(`${this.config.serverUrl}/_matrix/client/v3/delete_devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({
        devices: orphanIds,
        auth: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
          session: probeData.session,
        },
      }),
    });
    if (doDelete.ok) {
      console.log(`[Matrix] Deleted ${orphanIds.length} orphan devices`);
    } else {
      const errData = await doDelete.text();
      console.warn(`[Matrix] /delete_devices UIA step failed: ${doDelete.status} ${errData}`);
    }
  }

  // ── Messaging ──────────────────────────────────────────────

  async sendMessage(roomId: string, text: string, opts?: SendMessageOptions): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const content: any = {
      msgtype: MsgType.Text,
      body: text,
    };

    // Add formatted HTML
    const html = this.markdownToHtml(text);
    if (html !== text) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }

    const result = await this.client.sendMessage(roomId, content);
    return result.event_id!;
  }

  async sendDM(userId: string, text: string, opts?: SendMessageOptions): Promise<string> {
    const roomId = await this.findOrCreateDM(userId);
    return this.sendMessage(roomId, text, opts);
  }

  // ── Room Management ────────────────────────────────────────

  async createRoom(name: string, opts: CreateRoomOptions): Promise<PlatformRoom> {
    if (!this.client) throw new Error('Matrix client not started');

    const invite: string[] = [];
    if (opts.invite) {
      for (const handle of opts.invite) {
        const platformId = await this.resolvePlatformId(handle);
        if (platformId) invite.push(platformId);
      }
    }

    const initialState: any[] = [];
    if (opts.encrypted !== false) {
      initialState.push({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
    }

    const createOpts: any = {
      name: name || undefined,
      invite,
      preset: opts.type === 'dm' ? 'trusted_private_chat' : opts.type === 'channel' ? 'public_chat' : 'private_chat',
      initial_state: initialState,
      is_direct: opts.type === 'dm',
    };

    if (opts.topic) {
      createOpts.topic = opts.topic;
    }

    const result = await this.client.createRoom(createOpts);

    // Send wake message in encrypted rooms (Element withholds keys until bot speaks)
    if (opts.encrypted !== false) {
      try {
        await this.client.sendMessage(result.room_id, {
          msgtype: MsgType.Text,
          body: name ? `Room "${name}" created.` : 'Connected.',
        });
      } catch {
        // Non-fatal
      }
    }

    return {
      id: result.room_id,
      name,
      type: opts.type,
      topic: opts.topic,
      platform: 'matrix',
    };
  }

  async inviteToRoom(roomId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.invite(roomId, userId);
  }

  async removeFromRoom(roomId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.kick(roomId, userId);
  }

  async setRoomTopic(roomId: string, topic: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.setRoomTopic(roomId, topic);
  }

  async setUserRole(roomId: string, userId: string, role: 'admin' | 'moderator' | 'member'): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    const powerLevel = role === 'admin' ? 100 : role === 'moderator' ? 50 : 0;
    await this.client.setPowerLevel(roomId, userId, powerLevel);
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.redactEvent(roomId, messageId);
  }

  // ── Deep Notebook Integration ──────────────────────────────

  private async ensureRoomDirectoryVisibility(roomId: string, channelId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');

    try {
      await this.client.setRoomDirectoryVisibility(roomId, Visibility.Public);
    } catch (error) {
      console.warn(`[Matrix] Failed to publish #${channelId} to room directory:`, error);
    }
  }

  private async ensureSpaceMembership(roomId: string, channelId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    if (!this.config.spaceRoomId) return;
    if (roomId === this.config.spaceRoomId) return;

    try {
      await this.client.sendStateEvent(
        this.config.spaceRoomId,
        EventType.SpaceChild,
        { via: [this.config.serverName], suggested: true },
        roomId,
      );

      await this.client.sendStateEvent(
        roomId,
        EventType.SpaceParent,
        { via: [this.config.serverName], canonical: true },
        this.config.spaceRoomId,
      );
    } catch (error) {
      console.warn(`[Matrix] Failed to attach #${channelId} to space ${this.config.spaceRoomId}:`, error);
    }
  }

  async ensureChannelRoom(channelId: string, channelName: string, description?: string): Promise<string> {
    const cached = this.channelRooms.get(channelId);
    if (cached) return cached;

    if (!this.client) throw new Error('Matrix client not started');

    // Try to find existing room by alias
    const alias = `#${channelId}:${this.config.serverName}`;
    try {
      const resolved = await this.client.getRoomIdForAlias(alias);
      this.channelRooms.set(channelId, resolved.room_id);
      await this.ensureRoomDirectoryVisibility(resolved.room_id, channelId);
      await this.ensureSpaceMembership(resolved.room_id, channelId);
      return resolved.room_id;
    } catch {
      // Room doesn't exist, create it
    }

    const result = await this.client.createRoom({
      name: channelName,
      topic: description || `Hermes channel: #${channelId}`,
      room_alias_name: channelId,
      visibility: Visibility.Public,
      preset: Preset.PublicChat,
      initial_state: [
        {
          type: ROUTER_CHANNEL_STATE,
          state_key: '',
          content: { channel_id: channelId, name: channelName, description },
        },
      ],
    });

    this.channelRooms.set(channelId, result.room_id);
    await this.ensureRoomDirectoryVisibility(result.room_id, channelId);
    await this.ensureSpaceMembership(result.room_id, channelId);
    console.log(`[Matrix] Created room for #${channelId}: ${result.room_id}`);
    return result.room_id;
  }

  async postEntry(roomId: string, entry: {
    id: string;
    handle?: string;
    pseudonym: string;
    content: string;
    timestamp: number;
    topicHints?: string[];
    isReflection?: boolean;
  }, editorialHook?: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const baseUrl = this.config.baseUrl || 'https://hermes.teleport.computer';
    const permalink = `${baseUrl}/#entry-${entry.id}`;
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;

    const content: any = {
      msgtype: MsgType.Text,
      // Custom fields for Router Client rendering
      entry_id: entry.id,
      author_handle: entry.handle,
      author_pseudonym: entry.pseudonym,
      content: entry.content,
      editorial_hook: editorialHook,
      permalink,
      topic_hints: entry.topicHints,
      is_reflection: entry.isReflection,
      // Fallback text for stock clients
      body: editorialHook
        ? `${editorialHook}\n\n— ${author} · ${permalink}`
        : `${author}: ${entry.content.substring(0, 500)}${entry.content.length > 500 ? '...' : ''}\n\n${permalink}`,
    };

    // We use m.room.message with custom fields instead of a custom event type
    // because custom types don't render at all in stock Element.
    // The Router Client checks for entry_id to render as a card.
    const result = await this.client.sendMessage(roomId, content);
    const eventId = result.event_id!;

    this.entryEventMap.set(eventId, entry.id);
    return eventId;
  }

  async postSparkContext(roomId: string, spark: {
    sourceHandle: string;
    targetHandle: string;
    reason: string;
    evidence?: Array<{ entryId: string; author: string; snippet: string }>;
  }): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    // Set as room state
    await this.client.sendStateEvent(roomId, ROUTER_SPARK_EVENT as any, {
      source_handle: spark.sourceHandle,
      target_handle: spark.targetHandle,
      reason: spark.reason,
      evidence: spark.evidence || [],
      created_at: Date.now(),
    }, '');

    // Also send a visible message
    const result = await this.client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      body: `Connected: ${spark.reason}`,
      format: 'org.matrix.custom.html',
      formatted_body: `<strong>🔗 Connected:</strong> ${spark.reason}`,
    });
    return result.event_id!;
  }

  async syncProfile(handle: string, profile: { displayName?: string; bio?: string }): Promise<void> {
    if (!this.client) return;
    const userId = `@${handle}:${this.config.serverName}`;
    if (profile.displayName) {
      try {
        // Can only set own profile — would need admin API for others
        if (userId === this.botUserId) {
          await this.client.setDisplayName(profile.displayName);
        }
      } catch { /* Non-fatal */ }
    }
  }

  async joinUserToChannel(handle: string, channelId: string, channelName: string): Promise<void> {
    const roomId = await this.ensureChannelRoom(channelId, channelName);
    const userId = await this.resolvePlatformId(handle);
    if (userId) {
      await this.inviteToRoom(roomId, userId);
    }
  }

  getChannelRoomId(channelId: string): string | undefined {
    return this.channelRooms.get(channelId);
  }

  // ── Identity ───────────────────────────────────────────────

  async resolveHermesHandle(platformUserId: string): Promise<string | null> {
    const linkedHandle = await this.config.resolveLinkedHermesHandle?.(this.name, platformUserId);
    if (linkedHandle) return linkedHandle;

    const match = platformUserId.match(/^@([^:]+):/);
    return match ? match[1] : null;
  }

  async resolvePlatformId(hermesHandle: string): Promise<string | null> {
    const linkedUserId = await this.config.resolveLinkedPlatformId?.(this.name, hermesHandle);
    if (linkedUserId) return linkedUserId;

    return `@${hermesHandle}:${this.config.serverName}`;
  }

  // ── Formatting ─────────────────────────────────────────────

  formatContent(markdown: string): string {
    return markdown;
  }

  // ── Private ────────────────────────────────────────────────

  private setupEventListeners(): void {
    if (!this.client) return;

    // Handle incoming messages immediately when they are already decrypted.
    this.client.on(ClientEvent.Event, (event: MatrixEvent) => {
      this.handleIncomingMessageEvent(event);
    });

    // Also handle events that arrive encrypted and decrypt later once the room
    // key shows up. Without this, the first command after a fresh device reset
    // can be missed.
    this.client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent, err?: Error) => {
      if (err) return;
      this.handleIncomingMessageEvent(event);
    });

    // Auto-join on invite
    this.client.on(RoomMemberEvent.Membership, async (event: MatrixEvent, member: any) => {
      if (member.userId !== this.botUserId) return;
      if (member.membership !== KnownMembership.Invite) return;

      const roomId = member.roomId;
      try {
        await this.client!.joinRoom(roomId);
        console.log(`[Matrix] Auto-joined room ${roomId}`);

        // Delay the welcome message so room encryption state has time to sync.
        // Element withholds Megolm keys from devices that haven't "spoken" —
        // the wake message triggers key sharing — but sending too early fails
        // with "Cannot encrypt event in unconfigured room".
        setTimeout(async () => {
          try {
            await this.client!.sendMessage(roomId, {
              msgtype: MsgType.Text,
              body: 'Hi — I\'m the Router. Say `help` for what I can do, or `link` to connect your Hermes notebook account.',
            });
          } catch (err) {
            console.error(`[Matrix] Welcome message failed in ${roomId}:`, err);
          }
        }, 5000);
      } catch (err) {
        console.error(`[Matrix] Failed to join room ${roomId}:`, err);
      }
    });
  }

  private handleIncomingMessageEvent(event: MatrixEvent): void {
    if (!this.client) return;
    if (event.getType() !== EventType.RoomMessage) return;
    if (event.getSender() === this.botUserId) return;
    if (!event.getRoomId()) return;

    const eventId = event.getId();
    if (eventId && this.processedMessageEvents.has(eventId)) return;

    const content = event.getContent();
    const text = content.body || '';
    const sender = event.getSender()!;
    const roomId = event.getRoomId()!;

    // Resolve handle from Matrix user ID
    const handleMatch = sender.match(/^@([^:]+):/);
    const handle = handleMatch ? handleMatch[1] : null;

    // Detect if this is a DM to the bot (2-member room, bot is a member)
    const room = this.client.getRoom(roomId);
    const isDM = room ? room.getJoinedMemberCount() === 2 : false;

    // Treat direct DMs and explicit mentions as agent-directed messages.
    const isMention = isMatrixMention({
      isDM,
      text,
      content,
      botUserId: this.botUserId,
      botHandle: this.config.botHandle,
    });

    // Check if this is a reply to a notebook entry
    const replyToEventId = content['m.relates_to']?.['m.in_reply_to']?.event_id;
    const replyToEntryId = replyToEventId ? this.entryEventMap.get(replyToEventId) : undefined;

    // Check if the message itself contains entry data (reply to entry card)
    const isEntryMessage = content.entry_id != null;
    if (isEntryMessage && eventId) {
      this.entryEventMap.set(eventId, content.entry_id);
    }

    if (eventId) {
      this.processedMessageEvents.add(eventId);
      if (this.processedMessageEvents.size > 10000) {
        this.processedMessageEvents.clear();
      }
    }

    const eventData: Record<string, any> = {
      platform: 'matrix',
      room_id: roomId,
      message_id: eventId,
      sender_id: sender,
      sender_handle: handle,
      text,
      timestamp: event.getTs(),
      is_dm: isDM,
    };

    if (replyToEntryId) {
      eventData.reply_to_entry_id = replyToEntryId;
    }

    pushEvent(
      isMention ? 'platform_mention' : 'platform_message',
      eventData,
    );
  }

  /**
   * Bootstrap cross-signing and secret storage if not already set up.
   * This makes the bot behave like any Element user — its device self-signs,
   * other clients can verify it, and encrypted messages flow without special
   * trust relaxation.
   */
  private async bootstrapCryptoIdentity(username: string, password: string): Promise<void> {
    if (!this.client) return;
    const crypto = this.client.getCrypto();
    if (!crypto) {
      console.warn('[Matrix] No crypto backend — skipping cross-signing bootstrap');
      return;
    }

    // Check if cross-signing is already set up
    try {
      const isReady = await crypto.isCrossSigningReady();
      if (isReady) {
        console.log('[Matrix] Cross-signing already set up');
        return;
      }
    } catch {
      // Fall through to bootstrap
    }

    // Wait for /keys/query to settle so the bot's public cross-signing identity
    // is in the local crypto store. Without this, importing private keys from
    // SSSS fails with "No public identity found while importing cross-signing keys".
    console.log('[Matrix] Waiting for /keys/query to populate local identity cache...');
    try {
      const userId = this.client.getUserId()!;
      // downloadUncached: true forces a /keys/query and waits for the response.
      await crypto.getUserDeviceInfo([userId], true);
      // Give the store a beat to finish processing
      await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      console.warn('[Matrix] getUserDeviceInfo failed (continuing anyway):', err.message);
    }

    console.log('[Matrix] Bootstrapping cross-signing...');

    // UIA callback — provides password for uploading device signing keys.
    // matrix-js-sdk calls this with a function; we return auth data.
    // First invocation: return null to get session; second: return password auth.
    const authUploadDeviceSigningKeys = async (makeRequest: (authData: any) => Promise<any>): Promise<void> => {
      try {
        // First attempt — let the server tell us what auth is needed
        await makeRequest(null);
      } catch (err: any) {
        // UIA: server returned 401 with session + flows
        const data = err.data || err.httpStatus === 401 ? err.data : null;
        if (data?.session) {
          await makeRequest({
            session: data.session,
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: username },
            password,
          });
          return;
        }
        throw err;
      }
    };

    // Try up to 3 times — the first attempt often races with /keys/query
    // when restoring from SSSS.
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
        console.log('[Matrix] Cross-signing keys uploaded');
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[Matrix] Cross-signing bootstrap attempt ${attempt}/3 failed:`, err.message);
        if (attempt < 3) {
          // Force another keys/query and wait before retrying
          try {
            await crypto.getUserDeviceInfo([this.client.getUserId()!], true);
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
    if (lastErr) return;

    // Bootstrap secret storage (SSSS) with a recovery key derived from the bot's secret
    try {
      const isSecretStorageReady = await crypto.isSecretStorageReady();
      if (!isSecretStorageReady) {
        await crypto.bootstrapSecretStorage({
          setupNewKeyBackup: true,
          setupNewSecretStorage: true,
          createSecretStorageKey: async () => {
            // Derive a stable recovery key from the bot secret so it survives restarts
            return await crypto.createRecoveryKeyFromPassphrase(
              `router-ssss-${this.config.botSecretKey}`
            );
          },
        });
        console.log('[Matrix] Secret storage + key backup set up');
      }
    } catch (err: any) {
      console.warn('[Matrix] Secret storage bootstrap failed:', err.message);
    }
  }

  private markdownToHtml(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  }

  private async findOrCreateDM(userId: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    // Check existing rooms for DM
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      const members = room.getJoinedMembers();
      if (members.length === 2) {
        const memberIds = members.map(m => m.userId);
        if (memberIds.includes(userId) && memberIds.includes(this.botUserId!)) {
          return room.roomId;
        }
      }
    }

    // Create new DM
    const room = await this.createRoom('', {
      type: 'dm',
      invite: [],
      encrypted: true,
    });

    await this.inviteToRoom(room.id, userId);
    return room.id;
  }
}

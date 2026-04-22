/**
 * Raw SAS (m.sas.v1) verification — hand-rolled over both to-device AND
 * in-room flows.
 *
 * matrix-js-sdk's high-level VerificationRequest/Verifier API produces MACs
 * that Continuwuity rejects (m.mismatched_sas). Andrew Miller hit the same
 * wall and ported his own SAS driver in Python (shape-rotator-matrix,
 * sas_verification.py). This TS port does the same, but handles both
 * transports: Element picks in-room when there's an existing DM, to-device
 * otherwise.
 *
 * The bot auto-accepts every request and fires MAC immediately on receiving
 * the peer's ephemeral key — trust-on-first-verify, correct for a bot.
 */
import Olm from '@matrix-org/olm';
import {
  ClientEvent,
  RoomEvent,
  EventType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const SAS_METHOD = 'm.sas.v1';
const KEY_AGREEMENT = 'curve25519-hkdf-sha256';
const HASH_METHOD = 'sha256';
const MAC_METHOD = 'hkdf-hmac-sha256.v2';
const SAS_TYPES = ['emoji', 'decimal'];

let olmInitPromise: Promise<void> | null = null;
async function ensureOlmInitialized(): Promise<void> {
  if (!olmInitPromise) {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@matrix-org/olm/olm.wasm');
    olmInitPromise = Olm.init({
      locateFile: () => wasmPath,
      wasmBinary: readFileSync(wasmPath),
    } as any);
  }
  await olmInitPromise;
}

/** Canonical JSON per Matrix spec: UTF-8, no whitespace, keys sorted recursively. */
function canonicalJson(obj: any): string {
  const sortKeys = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(obj));
}

type Flow =
  | { kind: 'to-device' }
  | { kind: 'in-room'; roomId: string; requestEventId: string };

class SASSession {
  private sas: Olm.SAS;
  private cancelled = false;

  constructor(
    private readonly flow: Flow,
    private readonly txnId: string,
    private readonly theirUser: string,
    private readonly theirDevice: string,
    private readonly ourUser: string,
    private readonly ourDevice: string,
    private readonly ourSigningKey: string,
    private readonly client: MatrixClient,
  ) {
    this.sas = new Olm.SAS();
  }

  /** Route an outgoing verification event over the right transport. */
  private async send(eventType: string, rawContent: Record<string, any>): Promise<void> {
    if (this.flow.kind === 'to-device') {
      const content = { ...rawContent, transaction_id: this.txnId };
      const deviceMap = new Map<string, Record<string, any>>();
      deviceMap.set(this.theirDevice, content);
      const contentMap = new Map<string, Map<string, Record<string, any>>>();
      contentMap.set(this.theirUser, deviceMap);
      await this.client.sendToDevice(eventType, contentMap);
    } else {
      // In-room: relate to the original request event, no transaction_id field.
      const content = {
        ...rawContent,
        'm.relates_to': {
          rel_type: 'm.reference',
          event_id: this.flow.requestEventId,
        },
      };
      await this.client.sendEvent(this.flow.roomId, eventType as any, content);
    }
  }

  async handleRequest(): Promise<void> {
    console.log(`[SAS/${this.flow.kind}] Request from ${this.theirUser}/${this.theirDevice} txn=${this.txnId.slice(0, 16)}…`);
    await this.send('m.key.verification.ready', {
      from_device: this.ourDevice,
      methods: [SAS_METHOD],
    });
  }

  async handleStart(content: any): Promise<void> {
    if (content.method !== SAS_METHOD) {
      await this.cancel('m.unknown_method');
      return;
    }
    const ourPubkey = this.sas.get_pubkey();

    // Commitment hashes over the start event content. Strip transaction-
    // identifying fields per spec (transaction_id for to-device, and we
    // leave m.relates_to in for in-room since it's part of the content
    // the other side hashes too).
    const { transaction_id: _t, ...startCopy } = content;
    const commitmentInput = Buffer.concat([
      Buffer.from(ourPubkey, 'utf8'),
      Buffer.from(canonicalJson(startCopy), 'utf8'),
    ]);
    const commitment = createHash('sha256').update(commitmentInput).digest('base64');

    await this.send('m.key.verification.accept', {
      method: SAS_METHOD,
      key_agreement_protocol: KEY_AGREEMENT,
      hash: HASH_METHOD,
      message_authentication_code: MAC_METHOD,
      short_authentication_string: SAS_TYPES,
      commitment,
    });
  }

  async handleKey(content: any): Promise<void> {
    this.sas.set_their_key(content.key);
    await this.send('m.key.verification.key', {
      key: this.sas.get_pubkey(),
    });
    // Auto-confirm: send MAC immediately.
    await this.sendMac();
  }

  private macInfoSending(keyId: string): string {
    return 'MATRIX_KEY_VERIFICATION_MAC'
      + this.ourUser + this.ourDevice
      + this.theirUser + this.theirDevice
      + this.txnId + keyId;
  }
  private macInfoReceiving(keyId: string): string {
    return 'MATRIX_KEY_VERIFICATION_MAC'
      + this.theirUser + this.theirDevice
      + this.ourUser + this.ourDevice
      + this.txnId + keyId;
  }

  private async sendMac(): Promise<void> {
    const keyId = `ed25519:${this.ourDevice}`;
    const keyInfo = this.macInfoSending(keyId);
    const keysInfo = this.macInfoSending('KEY_IDS');
    const keyMac = this.sas.calculate_mac_fixed_base64(this.ourSigningKey, keyInfo);
    const keysMac = this.sas.calculate_mac_fixed_base64(keyId, keysInfo);

    // Diagnostic: dump everything needed to reproduce the MAC calculation.
    // If Element still rejects with m.mismatched_sas we can compare these
    // exact bytes against what rust-crypto computes on the other side.
    console.log(`[SAS/debug] txnId=${this.txnId}`);
    console.log(`[SAS/debug] ourUser=${this.ourUser} ourDevice=${this.ourDevice}`);
    console.log(`[SAS/debug] theirUser=${this.theirUser} theirDevice=${this.theirDevice}`);
    console.log(`[SAS/debug] ourSigningKey=${this.ourSigningKey}`);
    console.log(`[SAS/debug] keyInfo=${keyInfo}`);
    console.log(`[SAS/debug] keyMac=${keyMac}`);
    console.log(`[SAS/debug] keysInfo=${keysInfo}`);
    console.log(`[SAS/debug] keysMac=${keysMac}`);

    await this.send('m.key.verification.mac', {
      mac: { [keyId]: keyMac },
      keys: keysMac,
    });
    console.log(`[SAS/${this.flow.kind}] Sent MAC for ${this.ourUser}/${this.ourDevice}`);
  }

  async handleMac(content: any): Promise<void> {
    const theirSigningKey = await this.fetchTheirSigningKey();
    if (!theirSigningKey) {
      await this.cancel('m.key_mismatch');
      return;
    }
    const keyId = `ed25519:${this.theirDevice}`;
    const expectedKeyMac = this.sas.calculate_mac_fixed_base64(theirSigningKey, this.macInfoReceiving(keyId));
    const expectedKeysMac = this.sas.calculate_mac_fixed_base64(keyId, this.macInfoReceiving('KEY_IDS'));

    const mac = content.mac || {};
    const keysMac = content.keys || '';

    if (mac[keyId] !== expectedKeyMac || keysMac !== expectedKeysMac) {
      console.warn(`[SAS/${this.flow.kind}] MAC mismatch for ${this.theirUser}/${this.theirDevice}`);
      console.warn(`[SAS]   got     mac[${keyId}]=${mac[keyId]}`);
      console.warn(`[SAS]   expected             =${expectedKeyMac}`);
      console.warn(`[SAS]   got     keys=${keysMac}`);
      console.warn(`[SAS]   expected    =${expectedKeysMac}`);
      await this.cancel('m.key_mismatch');
      return;
    }
    console.log(`[SAS/${this.flow.kind}] ✅ Verified device ${this.theirUser}/${this.theirDevice}`);
    await this.send('m.key.verification.done', {});
  }

  private async fetchTheirSigningKey(): Promise<string | null> {
    const crypto = this.client.getCrypto();
    if (!crypto) return null;
    try {
      const devices = await crypto.getUserDeviceInfo([this.theirUser], true);
      const device = devices.get(this.theirUser)?.get(this.theirDevice);
      return device?.getFingerprint() || null;
    } catch (err: any) {
      console.warn(`[SAS] getUserDeviceInfo failed:`, err.message);
      return null;
    }
  }

  async cancel(code: string, reason: string = ''): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      await this.send('m.key.verification.cancel', { code, reason: reason || code });
    } catch (err: any) {
      console.warn(`[SAS] Cancel send failed:`, err.message);
    }
  }

  free(): void {
    try { this.sas.free(); } catch { /* ignore */ }
  }
}

export class SASVerificationManager {
  // Keyed by transaction_id (to-device) OR request event_id (in-room).
  private sessions = new Map<string, SASSession>();

  private constructor(
    private readonly client: MatrixClient,
    private readonly ourUser: string,
    private readonly ourDevice: string,
    private readonly ourSigningKey: string,
  ) {}

  static async create(client: MatrixClient): Promise<SASVerificationManager> {
    await ensureOlmInitialized();

    const ourUser = client.getUserId();
    const ourDevice = client.getDeviceId();
    if (!ourUser || !ourDevice) throw new Error('MatrixClient not logged in');
    const crypto = client.getCrypto();
    if (!crypto) throw new Error('No crypto backend');
    const ownKeys = await crypto.getOwnDeviceKeys();
    if (!ownKeys?.ed25519) throw new Error('Could not fetch own ed25519 key');

    const mgr = new SASVerificationManager(client, ourUser, ourDevice, ownKeys.ed25519);

    // To-device flow (when there's no pre-existing DM).
    (client as any).on(ClientEvent.ToDeviceEvent, (event: MatrixEvent) => {
      mgr.handleToDevice(event).catch(err =>
        console.error('[SAS/to-device] Handler error:', err.message));
    });

    // In-room flow (when Element has a DM open — this is the common case).
    (client as any).on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined) => {
      if (!room) return;
      mgr.handleInRoom(event, room).catch(err =>
        console.error('[SAS/in-room] Handler error:', err.message));
    });

    console.log(`[SAS] Manager ready: user=${ourUser} device=${ourDevice} ed25519=${ownKeys.ed25519.slice(0, 12)}…`);
    return mgr;
  }

  private async handleToDevice(event: MatrixEvent): Promise<void> {
    const type = event.getType();
    if (!type.startsWith('m.key.verification.')) return;
    const content: any = event.getContent();
    const sender = event.getSender();
    const txnId: string | undefined = content.transaction_id;
    if (!txnId || !sender) return;

    if (type === 'm.key.verification.request') {
      const theirDevice: string = content.from_device || '';
      if (!theirDevice) return;
      if (!this.sessions.has(txnId)) {
        this.sessions.set(txnId, new SASSession(
          { kind: 'to-device' },
          txnId, sender, theirDevice,
          this.ourUser, this.ourDevice, this.ourSigningKey,
          this.client,
        ));
      }
      await this.sessions.get(txnId)!.handleRequest();
      return;
    }

    const session = this.sessions.get(txnId);
    if (!session) return;
    await this.routeSubsequent(type, content, session, txnId);
  }

  private async handleInRoom(event: MatrixEvent, room: Room): Promise<void> {
    const sender = event.getSender();
    if (!sender || sender === this.ourUser) return;

    // In-room verification request is wrapped as m.room.message with a
    // dedicated msgtype. Subsequent events carry their real verification
    // type and reference the request event via m.relates_to.
    const type = event.getType();
    const content: any = event.getContent();

    if (type === EventType.RoomMessage && content.msgtype === 'm.key.verification.request') {
      const requestEventId = event.getId();
      if (!requestEventId) return;
      const theirDevice: string = content.from_device || '';
      if (!theirDevice) return;
      if (this.sessions.has(requestEventId)) return;
      this.sessions.set(requestEventId, new SASSession(
        { kind: 'in-room', roomId: room.roomId, requestEventId },
        requestEventId, sender, theirDevice,
        this.ourUser, this.ourDevice, this.ourSigningKey,
        this.client,
      ));
      await this.sessions.get(requestEventId)!.handleRequest();
      return;
    }

    if (!type.startsWith('m.key.verification.')) return;
    const relatesTo = content['m.relates_to'];
    const requestEventId: string | undefined = relatesTo?.event_id;
    if (!requestEventId) return;
    const session = this.sessions.get(requestEventId);
    if (!session) {
      console.log(`[SAS/in-room] Unknown request ${requestEventId.slice(0, 16)}…, ignoring ${type}`);
      return;
    }
    await this.routeSubsequent(type, content, session, requestEventId);
  }

  private async routeSubsequent(
    type: string,
    content: any,
    session: SASSession,
    txnId: string,
  ): Promise<void> {
    switch (type) {
      case 'm.key.verification.start':
        await session.handleStart(content);
        break;
      case 'm.key.verification.key':
        await session.handleKey(content);
        break;
      case 'm.key.verification.mac':
        await session.handleMac(content);
        session.free();
        this.sessions.delete(txnId);
        break;
      case 'm.key.verification.cancel':
        console.log(`[SAS] Cancelled: ${content.code || 'unknown'}`);
        session.free();
        this.sessions.delete(txnId);
        break;
      case 'm.key.verification.done':
        session.free();
        this.sessions.delete(txnId);
        break;
      // m.key.verification.ready / .accept come from the other side; we're the
      // responder so we don't normally receive these, but ignore them safely.
    }
  }
}

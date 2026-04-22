/**
 * Raw SAS (m.sas.v1) verification over to-device events.
 *
 * This is a port of Andrew Miller's sas_verification.py from
 * https://github.com/Account-Link/shape-rotator-matrix — his bot connects to
 * the same Continuwuity homeserver we're using, and he bypasses the SDK's
 * verification machinery entirely because it produces MACs that fail to
 * validate against this server. We hit the exact same m.mismatched_sas
 * failure through matrix-js-sdk's high-level SAS API, so we do the same:
 * drive the state machine by hand against raw to-device events, using
 * @matrix-org/olm for the SAS primitives.
 *
 * The bot auto-accepts every incoming request and sends its MAC immediately
 * after receiving the other side's ephemeral key — no emoji confirmation,
 * no human in the loop. For a bot, trust-on-first-verify is correct.
 */
import Olm from '@matrix-org/olm';
import { ClientEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
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
    // In Node we need to help Olm locate its wasm file. Resolve via the
    // CommonJS require so we get the module path regardless of CWD.
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@matrix-org/olm/olm.wasm');
    olmInitPromise = Olm.init({
      locateFile: () => wasmPath,
      // Some versions of @matrix-org/olm try to fetch() the wasm; provide
      // the bytes directly to skip the fetch path entirely.
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
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) {
        sorted[k] = sortKeys(v[k]);
      }
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sortKeys(obj));
}

class SASSession {
  private sas: Olm.SAS;
  private cancelled = false;

  constructor(
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

  private async send(eventType: string, content: Record<string, any>): Promise<void> {
    const deviceMap = new Map<string, Record<string, any>>();
    deviceMap.set(this.theirDevice, content);
    const contentMap = new Map<string, Map<string, Record<string, any>>>();
    contentMap.set(this.theirUser, deviceMap);
    await this.client.sendToDevice(eventType, contentMap);
  }

  async handleRequest(): Promise<void> {
    console.log(`[SAS] Request from ${this.theirUser}/${this.theirDevice} txn=${this.txnId}`);
    await this.send('m.key.verification.ready', {
      from_device: this.ourDevice,
      methods: [SAS_METHOD],
      transaction_id: this.txnId,
    });
  }

  async handleStart(content: any): Promise<void> {
    if (content.method !== SAS_METHOD) {
      await this.cancel('m.unknown_method');
      return;
    }
    const ourPubkey = this.sas.get_pubkey();
    const { transaction_id: _, ...startCopy } = content;
    // commitment = base64( sha256( pubkey_str + canonical_json(start_minus_txn) ) )
    const commitmentInput = Buffer.concat([
      Buffer.from(ourPubkey, 'utf8'),
      Buffer.from(canonicalJson(startCopy), 'utf8'),
    ]);
    const commitment = createHash('sha256').update(commitmentInput).digest('base64');

    await this.send('m.key.verification.accept', {
      transaction_id: this.txnId,
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
      transaction_id: this.txnId,
      key: this.sas.get_pubkey(),
    });
    // Bot auto-confirms: immediately send MAC, no emoji step.
    await this.sendMac();
  }

  /**
   * Info strings for MAC, per Matrix SAS spec:
   * sending:   "MATRIX_KEY_VERIFICATION_MAC" + our_user + our_device + their_user + their_device + txn + key_id
   * receiving: "MATRIX_KEY_VERIFICATION_MAC" + their_user + their_device + our_user + our_device + txn + key_id
   *
   * The concat is bare, no separators. Getting the order wrong is the classic
   * m.mismatched_sas cause.
   */
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
    // v2 MAC is calculate_mac_fixed_base64 in libolm (unpadded base64).
    const keyMac = this.sas.calculate_mac_fixed_base64(this.ourSigningKey, this.macInfoSending(keyId));
    const keysMac = this.sas.calculate_mac_fixed_base64(keyId, this.macInfoSending('KEY_IDS'));
    await this.send('m.key.verification.mac', {
      transaction_id: this.txnId,
      mac: { [keyId]: keyMac },
      keys: keysMac,
    });
    console.log(`[SAS] Sent MAC for ${this.ourUser}/${this.ourDevice}`);
  }

  async handleMac(content: any): Promise<void> {
    const theirSigningKey = await this.fetchTheirSigningKey();
    if (!theirSigningKey) {
      console.warn(`[SAS] Could not fetch signing key for ${this.theirUser}/${this.theirDevice}`);
      await this.cancel('m.key_mismatch');
      return;
    }
    const keyId = `ed25519:${this.theirDevice}`;
    const expectedKeyMac = this.sas.calculate_mac_fixed_base64(theirSigningKey, this.macInfoReceiving(keyId));
    const expectedKeysMac = this.sas.calculate_mac_fixed_base64(keyId, this.macInfoReceiving('KEY_IDS'));

    const mac = content.mac || {};
    const keysMac = content.keys || '';

    if (mac[keyId] !== expectedKeyMac || keysMac !== expectedKeysMac) {
      console.warn(`[SAS] MAC mismatch for ${this.theirUser}/${this.theirDevice}`);
      console.warn(`[SAS]   got mac[${keyId}]=${mac[keyId]}`);
      console.warn(`[SAS]   expected        =${expectedKeyMac}`);
      console.warn(`[SAS]   got keys=${keysMac}`);
      console.warn(`[SAS]   expected=${expectedKeysMac}`);
      await this.cancel('m.key_mismatch');
      return;
    }

    console.log(`[SAS] ✅ Verified device ${this.theirUser}/${this.theirDevice}`);
    await this.send('m.key.verification.done', { transaction_id: this.txnId });
  }

  private async fetchTheirSigningKey(): Promise<string | null> {
    const crypto = this.client.getCrypto();
    if (!crypto) return null;
    try {
      const devices = await crypto.getUserDeviceInfo([this.theirUser], true);
      const device = devices.get(this.theirUser)?.get(this.theirDevice);
      if (!device) return null;
      return device.getFingerprint() || null;
    } catch (err: any) {
      console.warn(`[SAS] getUserDeviceInfo failed:`, err.message);
      return null;
    }
  }

  async cancel(code: string, reason: string = ''): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      await this.send('m.key.verification.cancel', {
        transaction_id: this.txnId,
        code,
        reason: reason || code,
      });
    } catch (err: any) {
      console.warn(`[SAS] Cancel send failed:`, err.message);
    }
  }

  free(): void {
    try { this.sas.free(); } catch { /* ignore */ }
  }
}

export class SASVerificationManager {
  private sessions = new Map<string, SASSession>();

  private constructor(
    private readonly client: MatrixClient,
    private readonly ourUser: string,
    private readonly ourDevice: string,
    private readonly ourSigningKey: string,
  ) {}

  /**
   * Factory: initializes Olm, looks up the bot's ed25519 fingerprint, wires
   * up the to-device event listener.
   */
  static async create(client: MatrixClient): Promise<SASVerificationManager> {
    await ensureOlmInitialized();

    const ourUser = client.getUserId();
    const ourDevice = client.getDeviceId();
    if (!ourUser || !ourDevice) {
      throw new Error('MatrixClient not logged in — cannot init SAS manager');
    }
    const crypto = client.getCrypto();
    if (!crypto) throw new Error('No crypto backend — cannot init SAS manager');
    const ownKeys = await crypto.getOwnDeviceKeys();
    if (!ownKeys?.ed25519) throw new Error('Could not fetch own ed25519 key');

    const mgr = new SASVerificationManager(client, ourUser, ourDevice, ownKeys.ed25519);
    (client as any).on(ClientEvent.ToDeviceEvent, (event: MatrixEvent) => {
      mgr.handleToDevice(event).catch(err => {
        console.error('[SAS] Handler error:', err.message);
      });
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

    // Request creates the session; everything else expects one to exist.
    if (type === 'm.key.verification.request') {
      const theirDevice: string = content.from_device || '';
      if (!theirDevice) return;
      // If a session already exists for this txn, reuse it (idempotent).
      if (!this.sessions.has(txnId)) {
        this.sessions.set(txnId, new SASSession(
          txnId, sender, theirDevice,
          this.ourUser, this.ourDevice, this.ourSigningKey,
          this.client,
        ));
      }
      await this.sessions.get(txnId)!.handleRequest();
      return;
    }

    const session = this.sessions.get(txnId);
    if (!session) {
      console.log(`[SAS] Unknown txn ${txnId}, ignoring ${type}`);
      return;
    }

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
        console.log(`[SAS] Cancelled by ${sender}: ${content.code || 'unknown'}`);
        session.free();
        this.sessions.delete(txnId);
        break;
      case 'm.key.verification.done':
        // Both sides happy; clean up.
        session.free();
        this.sessions.delete(txnId);
        break;
    }
  }
}

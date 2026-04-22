/**
 * Auto-accept Matrix SAS verification requests using matrix-js-sdk's Rust
 * crypto verifier.
 *
 * The previous hand-rolled libolm driver was useful while debugging crypto
 * store persistence, but the persistent Rust crypto store is now working. Let
 * the same verifier implementation as Element construct the accept/key/MAC
 * events so we don't drift on SAS details.
 */
import { type MatrixClient } from 'matrix-js-sdk';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api/index.js';

const SAS_METHOD = 'm.sas.v1';

export class SASVerificationManager {
  private readonly activeRequests = new Set<string>();
  private readonly activeVerifiers = new WeakSet<Verifier>();

  private constructor(private readonly client: MatrixClient) {}

  static async create(client: MatrixClient): Promise<SASVerificationManager> {
    const crypto = client.getCrypto();
    if (!crypto) throw new Error('No crypto backend');

    const ownKeys = await crypto.getOwnDeviceKeys();
    const mgr = new SASVerificationManager(client);

    (crypto as any).on(CryptoEvent.VerificationRequestReceived, (request: VerificationRequest) => {
      mgr.handleRequest(request).catch(err =>
        console.error('[SAS/sdk] Handler error:', err.message));
    });

    console.log(
      `[SAS] Manager ready: user=${client.getUserId()} device=${client.getDeviceId()} ed25519=${ownKeys.ed25519?.slice(0, 12)}...`,
    );
    return mgr;
  }

  private requestKey(request: VerificationRequest): string {
    return `${request.roomId || 'to-device'}:${request.otherUserId}:${request.transactionId || 'pending'}`;
  }

  private async handleRequest(request: VerificationRequest): Promise<void> {
    const key = this.requestKey(request);
    if (this.activeRequests.has(key)) return;
    this.activeRequests.add(key);

    console.log(
      `[SAS/sdk] Request from ${request.otherUserId}/${request.otherDeviceId || 'unknown'} txn=${request.transactionId?.slice(0, 16) || 'pending'} phase=${request.phase}`,
    );

    request.on(VerificationRequestEvent.Change, () => {
      this.driveRequest(request).catch(err =>
        console.error('[SAS/sdk] Drive error:', err.message));
    });

    await this.driveRequest(request);
  }

  private async driveRequest(request: VerificationRequest): Promise<void> {
    if (request.phase === VerificationPhase.Cancelled) {
      console.log(`[SAS/sdk] Cancelled: ${request.cancellationCode || 'unknown'}`);
      this.activeRequests.delete(this.requestKey(request));
      return;
    }
    if (request.phase === VerificationPhase.Done) {
      console.log(`[SAS/sdk] Verified ${request.otherUserId}/${request.otherDeviceId || 'unknown'}`);
      this.activeRequests.delete(this.requestKey(request));
      return;
    }

    if (request.phase === VerificationPhase.Requested && !request.accepting) {
      console.log(`[SAS/sdk] Accepting request ${request.transactionId || ''}`);
      await request.accept();
      return;
    }

    const verifier = request.verifier;
    if (!verifier || this.activeVerifiers.has(verifier)) return;

    this.activeVerifiers.add(verifier);
    this.installVerifierHandlers(verifier);

    console.log(`[SAS/sdk] Starting verifier for ${verifier.userId}`);
    verifier.verify()
      .then(() => console.log(`[SAS/sdk] Verifier complete for ${verifier.userId}`))
      .catch(err => console.warn('[SAS/sdk] Verifier failed:', err.message || err));
  }

  private installVerifierHandlers(verifier: Verifier): void {
    verifier.on(VerifierEvent.ShowSas, (sas: ShowSasCallbacks) => {
      const emoji = sas.sas.emoji?.map(([symbol, name]) => `${symbol} ${name}`).join(', ');
      const decimal = sas.sas.decimal?.join('-');
      console.log(`[SAS/sdk] SAS shown emoji=${emoji || 'none'} decimal=${decimal || 'none'}; auto-confirming`);

      sas.confirm().catch(err =>
        console.warn('[SAS/sdk] SAS confirm failed:', err.message || err));
    });

    verifier.on(VerifierEvent.Cancel, (err: Error | unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[SAS/sdk] Verifier cancelled: ${message}`);
    });
  }
}

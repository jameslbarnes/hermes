/**
 * Persistent IndexedDB for matrix-js-sdk crypto store.
 *
 * `fake-indexeddb` is in-memory only. Every Node restart wipes the bot's
 * Olm sessions, device keys, cross-signing state, Megolm session keys, etc.
 * That forces a full re-bootstrap on every deploy, creates orphan devices
 * on the homeserver, breaks trust chains, and prevents the bot from
 * decrypting past messages.
 *
 * This module persists the entire IndexedDB state to a JSON file and
 * restores it on startup. It hooks into `fake-indexeddb`'s internal
 * structured-clone storage and snapshots it through the public API.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PersistOptions {
  /** Path to the persistence file. The directory will be created if needed. */
  filePath: string;
  /** How often to flush to disk, in milliseconds. Default: 30 seconds. */
  flushIntervalMs?: number;
}

/** Dump one IndexedDB database to a plain object. */
async function dumpDatabase(dbName: string): Promise<any | null> {
  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve(null);
    openReq.onsuccess = async () => {
      const db = openReq.result;
      const out: { version: number; stores: Record<string, any[]> } = {
        version: db.version,
        stores: {},
      };
      const storeNames = Array.from(db.objectStoreNames);
      if (storeNames.length === 0) {
        db.close();
        resolve(out);
        return;
      }
      try {
        const tx = db.transaction(storeNames, 'readonly');
        let pending = storeNames.length;
        for (const storeName of storeNames) {
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          const keyReq = store.getAllKeys();
          const entries: any[] = [];
          req.onsuccess = () => {
            keyReq.onsuccess = () => {
              const values = req.result;
              const keys = keyReq.result;
              for (let i = 0; i < values.length; i++) {
                entries.push({ key: keys[i], value: values[i] });
              }
              out.stores[storeName] = entries;
              if (--pending === 0) {
                db.close();
                resolve(out);
              }
            };
          };
          req.onerror = () => {
            if (--pending === 0) {
              db.close();
              resolve(out);
            }
          };
        }
      } catch (e) {
        db.close();
        resolve(null);
      }
    };
  });
}

/** List all IndexedDB databases that start with a given prefix. */
async function listDatabasesWithPrefix(prefix: string): Promise<string[]> {
  try {
    // @ts-ignore — databases() is on IDBFactory
    const dbs = await indexedDB.databases();
    return dbs
      .map((d: any) => d.name as string)
      .filter((n: string) => n && n.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Restore one database from a dump. */
async function restoreDatabase(dbName: string, dump: any): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!dump || !dump.stores) return resolve();
    const openReq = indexedDB.open(dbName, dump.version);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      // We don't recreate schema here — the Rust WASM layer creates stores
      // via its own upgrade path. We only restore data after it has done so.
      for (const storeName of Object.keys(dump.stores)) {
        if (!db.objectStoreNames.contains(storeName)) {
          // Store doesn't exist — can't restore into it without schema info.
          // Rust crypto will re-migrate and create stores fresh.
          console.warn(`[CryptoPersist] Store "${storeName}" missing during restore, skipping`);
        }
      }
    };
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = async () => {
      const db = openReq.result;
      const storeNames = Array.from(db.objectStoreNames);
      try {
        const tx = db.transaction(storeNames, 'readwrite');
        for (const storeName of storeNames) {
          const entries = dump.stores[storeName];
          if (!Array.isArray(entries)) continue;
          const store = tx.objectStore(storeName);
          for (const { key, value } of entries) {
            try {
              // Use put with explicit key — works for both inline and out-of-line keys
              if (store.keyPath !== null) {
                store.put(value);
              } else {
                store.put(value, key);
              }
            } catch (e) {
              // Skip bad entries
            }
          }
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

/**
 * Restore the crypto store from a persisted snapshot (if one exists).
 * Call this BEFORE creating the MatrixClient / calling initRustCrypto.
 */
export async function restoreCryptoStore(opts: PersistOptions): Promise<boolean> {
  if (!existsSync(opts.filePath)) {
    console.log('[CryptoPersist] No snapshot found, starting fresh');
    return false;
  }

  let snapshot: Record<string, any>;
  try {
    const raw = readFileSync(opts.filePath, 'utf8');
    snapshot = JSON.parse(raw);
  } catch (err: any) {
    console.warn('[CryptoPersist] Failed to read snapshot:', err.message);
    return false;
  }

  // Restoring data before the schema is created by Rust crypto won't work
  // (onupgradeneeded is where matrix-rust-sdk creates its stores). We need
  // to let it create the schema, then inject our data afterwards.
  //
  // Strategy: don't restore here. Instead, return the snapshot so the
  // caller can apply it AFTER initRustCrypto has created the stores.
  (globalThis as any).__ROUTER_CRYPTO_SNAPSHOT__ = snapshot;
  console.log(`[CryptoPersist] Loaded snapshot (${Object.keys(snapshot).length} databases)`);
  return true;
}

/**
 * Apply a previously-loaded snapshot to the already-initialized IndexedDB stores.
 * Call this AFTER initRustCrypto has completed its schema migrations.
 */
export async function applyCryptoSnapshot(): Promise<void> {
  const snapshot = (globalThis as any).__ROUTER_CRYPTO_SNAPSHOT__;
  if (!snapshot) return;

  const existingDbs = await listDatabasesWithPrefix('');
  for (const dbName of Object.keys(snapshot)) {
    if (!existingDbs.includes(dbName)) {
      // Rust crypto hasn't created this DB — skip
      continue;
    }
    try {
      await restoreDatabase(dbName, snapshot[dbName]);
      console.log(`[CryptoPersist] Restored ${dbName}`);
    } catch (err: any) {
      console.warn(`[CryptoPersist] Restore failed for ${dbName}:`, err.message);
    }
  }
  delete (globalThis as any).__ROUTER_CRYPTO_SNAPSHOT__;
}

let flushInterval: ReturnType<typeof setInterval> | null = null;
let currentOpts: PersistOptions | null = null;

/**
 * Start periodic snapshotting of the IndexedDB state to disk.
 * Call this after initRustCrypto has completed.
 */
export function startPersisting(opts: PersistOptions): void {
  currentOpts = opts;
  const interval = opts.flushIntervalMs || 30_000;

  const dir = dirname(opts.filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  flushInterval = setInterval(() => {
    flushCryptoStore().catch(err => {
      console.warn('[CryptoPersist] Periodic flush failed:', err.message);
    });
  }, interval);

  console.log(`[CryptoPersist] Started periodic persist every ${interval}ms → ${opts.filePath}`);
}

/**
 * Flush the current IndexedDB state to disk. Called periodically and on shutdown.
 */
export async function flushCryptoStore(): Promise<void> {
  if (!currentOpts) return;

  const dbNames = await listDatabasesWithPrefix('router-crypto-');
  if (dbNames.length === 0) return;

  const snapshot: Record<string, any> = {};
  for (const dbName of dbNames) {
    const dump = await dumpDatabase(dbName);
    if (dump) snapshot[dbName] = dump;
  }

  try {
    writeFileSync(currentOpts.filePath, JSON.stringify(snapshot), 'utf8');
  } catch (err: any) {
    console.warn('[CryptoPersist] Write failed:', err.message);
  }
}

export function stopPersisting(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}

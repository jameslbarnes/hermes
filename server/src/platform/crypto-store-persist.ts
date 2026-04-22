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
 * restores it on startup through the public IndexedDB API. The important
 * detail is that restore must happen before Rust crypto opens the store:
 * by the time initRustCrypto() returns, the Olm account has already been
 * loaded or freshly generated.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';

export interface PersistOptions {
  /** Path to the persistence file. The directory will be created if needed. */
  filePath: string;
  /** How often to flush to disk, in milliseconds. Default: 30 seconds. */
  flushIntervalMs?: number;
}

interface IndexDump {
  name: string;
  keyPath: string | string[] | null;
  unique: boolean;
  multiEntry: boolean;
}

interface StoreDump {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexDump[];
  entries: Array<{ key: IDBValidKey; value: any }>;
}

interface DatabaseDump {
  version: number;
  stores: Record<string, StoreDump | Array<{ key: IDBValidKey; value: any }>>;
}

const RUST_CRYPTO_MAIN_STORES: Record<string, IndexDump[]> = {
  backup_keys: [],
  core: [],
  devices: [],
  gossip_requests: [
    { name: 'by_info', keyPath: 'info', unique: true, multiEntry: false },
    { name: 'unsent', keyPath: 'unsent', unique: false, multiEntry: false },
  ],
  identities: [],
  inbound_group_sessions3: [
    { name: 'backed_up_to', keyPath: 'backed_up_to', unique: false, multiEntry: false },
    { name: 'backup', keyPath: 'needs_backup', unique: false, multiEntry: false },
    {
      name: 'inbound_group_session_sender_key_sender_data_type_idx',
      keyPath: ['sender_key', 'sender_data_type', 'session_id'],
      unique: false,
      multiEntry: false,
    },
  ],
  lease_locks: [],
  olm_hashes: [],
  outbound_group_sessions: [],
  received_room_key_bundles: [],
  room_key_backups_fully_downloaded: [],
  room_settings: [],
  rooms_pending_key_bundle: [],
  secrets_inbox2: [],
  session: [],
  tracked_users: [],
  withheld_sessions: [],
};

function fallbackStoreDump(dbName: string, storeName: string, dump: any): StoreDump {
  const entries = Array.isArray(dump) ? dump : dump?.entries || [];
  const indexes =
    dbName.endsWith('::matrix-sdk-crypto')
      ? RUST_CRYPTO_MAIN_STORES[storeName] || []
      : [];

  return {
    keyPath: dump?.keyPath ?? null,
    autoIncrement: dump?.autoIncrement ?? false,
    indexes: dump?.indexes || indexes,
    entries,
  };
}

function createStore(db: IDBDatabase, storeName: string, storeDump: StoreDump): void {
  if (db.objectStoreNames.contains(storeName)) return;

  const opts: IDBObjectStoreParameters = {};
  if (storeDump.keyPath !== null) opts.keyPath = storeDump.keyPath;
  if (storeDump.autoIncrement) opts.autoIncrement = true;

  const store = db.createObjectStore(storeName, opts);
  for (const index of storeDump.indexes || []) {
    if (store.indexNames.contains(index.name)) continue;
    store.createIndex(index.name, index.keyPath as any, {
      unique: index.unique,
      multiEntry: index.multiEntry,
    });
  }
}

/** Dump one IndexedDB database to a plain object. */
async function dumpDatabase(dbName: string): Promise<DatabaseDump | null> {
  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve(null);
    openReq.onsuccess = async () => {
      const db = openReq.result;
      const out: DatabaseDump = {
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
          const storeDump: StoreDump = {
            keyPath: store.keyPath as string | string[] | null,
            autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames).map((name) => {
              const index = store.index(name);
              return {
                name,
                keyPath: index.keyPath as string | string[] | null,
                unique: index.unique,
                multiEntry: index.multiEntry,
              };
            }),
            entries: [],
          };
          const req = store.getAll();
          const keyReq = store.getAllKeys();
          req.onsuccess = () => {
            keyReq.onsuccess = () => {
              const values = req.result;
              const keys = keyReq.result;
              for (let i = 0; i < values.length; i++) {
                storeDump.entries.push({ key: keys[i], value: values[i] });
              }
              out.stores[storeName] = storeDump;
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
    const openReq = indexedDB.open(dbName, dump.version || 1);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      for (const storeName of Object.keys(dump.stores)) {
        createStore(db, storeName, fallbackStoreDump(dbName, storeName, dump.stores[storeName]));
      }
    };
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = async () => {
      const db = openReq.result;
      const storeNames = Array.from(db.objectStoreNames);
      try {
        const tx = db.transaction(storeNames, 'readwrite');
        for (const storeName of storeNames) {
          const storeDump = fallbackStoreDump(dbName, storeName, dump.stores[storeName]);
          const entries = storeDump.entries;
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

async function deleteDatabaseIfExists(dbName: string): Promise<void> {
  const existing = await listDatabasesWithPrefix('');
  if (!existing.includes(dbName)) return;

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`delete blocked for ${dbName}`));
  });
}

/**
 * Quarantine an unusable snapshot and clear any restored in-memory databases.
 * This is intentionally scoped to the rust-crypto DB prefix so unrelated
 * fake-indexeddb users are not touched.
 */
export async function resetCryptoStoreSnapshot(filePath: string, dbPrefix: string): Promise<void> {
  if (existsSync(filePath)) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(filePath, quarantinePath);
      console.warn(`[CryptoPersist] Quarantined incompatible snapshot at ${quarantinePath}`);
    } catch (err: any) {
      console.warn('[CryptoPersist] Snapshot quarantine failed, deleting instead:', err.message);
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  const dbNames = await listDatabasesWithPrefix(`${dbPrefix}::matrix-sdk-crypto`);
  for (const dbName of dbNames) {
    try {
      await deleteDatabaseIfExists(dbName);
      console.warn(`[CryptoPersist] Cleared restored database ${dbName}`);
    } catch (err: any) {
      console.warn(`[CryptoPersist] Failed to clear ${dbName}:`, err.message);
    }
  }
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

  let restored = 0;
  for (const dbName of Object.keys(snapshot)) {
    try {
      await deleteDatabaseIfExists(dbName);
      await restoreDatabase(dbName, snapshot[dbName]);
      console.log(`[CryptoPersist] Restored ${dbName}`);
      restored++;
    } catch (err: any) {
      console.warn(`[CryptoPersist] Restore failed for ${dbName}:`, err.message);
    }
  }

  console.log(`[CryptoPersist] Loaded snapshot (${restored}/${Object.keys(snapshot).length} databases)`);
  return restored > 0;
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

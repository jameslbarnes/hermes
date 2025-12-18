/**
 * Hermes Storage Layer
 *
 * Simple interface for storing journal entries.
 * Implementations can be swapped (in-memory, SQLite, Postgres, etc.)
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';

export interface JournalEntry {
  id: string;
  pseudonym: string;
  client: 'desktop' | 'mobile' | 'code';
  content: string;
  timestamp: number;
  keywords?: string[]; // Tokenized content for search
  publishAt?: number; // When entry becomes public. If undefined or in past, entry is published.
}

export interface Summary {
  id: string;
  pseudonym: string;
  content: string;
  timestamp: number; // When summary was created
  entryIds: string[]; // IDs of entries covered by this summary
  startTime: number; // Timestamp of first entry in summary
  endTime: number; // Timestamp of last entry in summary
}

// Common stop words to exclude from search
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where',
  'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'about', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'any', 'also', 'being', 'their',
  'them', 'him', 'her', 'our', 'your', 'out', 'up', 'down', 'off', 'over',
]);

/**
 * Tokenize text into searchable keywords
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index); // unique
}

export interface Storage {
  /** Add a new entry */
  addEntry(entry: Omit<JournalEntry, 'id'>): Promise<JournalEntry>;

  /** Get a single entry by ID */
  getEntry(id: string): Promise<JournalEntry | null>;

  /** Get recent entries (newest first) */
  getEntries(limit?: number, offset?: number): Promise<JournalEntry[]>;

  /** Get entries by pseudonym */
  getEntriesByPseudonym(pseudonym: string, limit?: number): Promise<JournalEntry[]>;

  /** Search entries by keywords */
  searchEntries(query: string, limit?: number): Promise<JournalEntry[]>;

  /** Get total entry count */
  getEntryCount(): Promise<number>;

  /** Delete an entry by ID */
  deleteEntry(id: string): Promise<void>;
}

/**
 * In-memory storage for development/testing
 */
export class MemoryStorage implements Storage {
  private entries: JournalEntry[] = [];
  private nextId = 1;

  async addEntry(entry: Omit<JournalEntry, 'id'>): Promise<JournalEntry> {
    const newEntry: JournalEntry = {
      ...entry,
      id: String(this.nextId++),
    };
    this.entries.unshift(newEntry); // Add to front for newest-first ordering
    return newEntry;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    return this.entries.find(e => e.id === id) || null;
  }

  async getEntries(limit = 50, offset = 0): Promise<JournalEntry[]> {
    return this.entries.slice(offset, offset + limit);
  }

  async getEntriesByPseudonym(pseudonym: string, limit = 50): Promise<JournalEntry[]> {
    return this.entries
      .filter(e => e.pseudonym === pseudonym)
      .slice(0, limit);
  }

  async getEntryCount(): Promise<number> {
    return this.entries.length;
  }

  async searchEntries(query: string, limit = 50): Promise<JournalEntry[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    return this.entries
      .filter(e => {
        const entryKeywords = e.keywords || tokenize(e.content);
        return queryKeywords.some(qk => entryKeywords.includes(qk));
      })
      .slice(0, limit);
  }

  async deleteEntry(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
  }
}

/**
 * Generate a unique entry ID
 */
export function generateEntryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Firestore storage for production
 */
export class FirestoreStorage implements Storage {
  private db: Firestore;
  private collection = 'entries';

  constructor() {
    // Initialize Firebase if not already initialized
    if (getApps().length === 0) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
      const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
      const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      if (serviceAccountBase64) {
        // Base64-encoded JSON in env var
        const decoded = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
        initializeApp({
          credential: cert(JSON.parse(decoded)),
        });
      } else if (serviceAccountJson) {
        // JSON string in env var
        initializeApp({
          credential: cert(JSON.parse(serviceAccountJson)),
        });
      } else if (serviceAccountPath) {
        // Path to JSON file
        initializeApp({
          credential: cert(serviceAccountPath),
        });
      } else {
        // Use application default credentials (for local dev with gcloud auth)
        initializeApp();
      }
    }
    this.db = getFirestore();
  }

  async addEntry(entry: Omit<JournalEntry, 'id'>): Promise<JournalEntry> {
    const id = generateEntryId();
    const keywords = tokenize(entry.content);
    const newEntry: JournalEntry = { ...entry, id, keywords };

    await this.db.collection(this.collection).doc(id).set({
      pseudonym: newEntry.pseudonym,
      client: newEntry.client,
      content: newEntry.content,
      timestamp: newEntry.timestamp,
      keywords,
    });

    return newEntry;
  }

  async getEntries(limit = 50, offset = 0): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .orderBy('timestamp', 'desc')
      .limit(limit + offset)
      .get();

    const entries: JournalEntry[] = [];
    snapshot.docs.slice(offset).forEach(doc => {
      entries.push({
        id: doc.id,
        ...doc.data(),
      } as JournalEntry);
    });

    return entries;
  }

  async getEntriesByPseudonym(pseudonym: string, limit = 50): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  async getEntryCount(): Promise<number> {
    const snapshot = await this.db.collection(this.collection).count().get();
    return snapshot.data().count;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    const doc = await this.db.collection(this.collection).doc(id).get();
    if (!doc.exists) return null;
    return {
      id: doc.id,
      ...doc.data(),
    } as JournalEntry;
  }

  async deleteEntry(id: string): Promise<void> {
    await this.db.collection(this.collection).doc(id).delete();
  }

  async searchEntries(query: string, limit = 50): Promise<JournalEntry[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    // Firestore array-contains-any supports up to 30 values
    const searchKeywords = queryKeywords.slice(0, 30);

    const snapshot = await this.db
      .collection(this.collection)
      .where('keywords', 'array-contains-any', searchKeywords)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  // ─────────────────────────────────────────────────────────────
  // Summary methods
  // ─────────────────────────────────────────────────────────────

  async addSummary(summary: Omit<Summary, 'id'>): Promise<Summary> {
    const id = generateEntryId();
    const newSummary: Summary = { ...summary, id };

    await this.db.collection('summaries').doc(id).set({
      pseudonym: newSummary.pseudonym,
      content: newSummary.content,
      timestamp: newSummary.timestamp,
      entryIds: newSummary.entryIds,
      startTime: newSummary.startTime,
      endTime: newSummary.endTime,
    });

    return newSummary;
  }

  async getSummaries(limit = 50): Promise<Summary[]> {
    const snapshot = await this.db
      .collection('summaries')
      .orderBy('endTime', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Summary));
  }

  async getLastSummaryForPseudonym(pseudonym: string): Promise<Summary | null> {
    const snapshot = await this.db
      .collection('summaries')
      .where('pseudonym', '==', pseudonym)
      .orderBy('endTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data(),
    } as Summary;
  }

  async getEntriesInRange(pseudonym: string, startTime: number, endTime: number): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .where('timestamp', '>=', startTime)
      .where('timestamp', '<=', endTime)
      .orderBy('timestamp', 'asc')
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }
}

/**
 * Staged storage: entries live in memory for 1 hour before publishing to Firestore
 */
export class StagedStorage implements Storage {
  private pending: Map<string, JournalEntry> = new Map();
  private published: FirestoreStorage;
  private publishDelayMs: number;
  private publishInterval: NodeJS.Timeout | null = null;
  private onPublishCallback: ((entry: JournalEntry) => void) | null = null;

  constructor(publishDelayMs = 60 * 60 * 1000) { // Default 1 hour
    this.published = new FirestoreStorage();
    this.publishDelayMs = publishDelayMs;
    this.startPublishLoop();
  }

  /**
   * Register callback to be called when an entry is published
   */
  onPublish(callback: (entry: JournalEntry) => void) {
    this.onPublishCallback = callback;
  }

  private startPublishLoop() {
    // Check every minute for entries ready to publish
    this.publishInterval = setInterval(() => this.publishReadyEntries(), 60 * 1000);
  }

  private async publishReadyEntries() {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.publishAt && entry.publishAt <= now) {
        // Move to Firestore without publishAt field
        const { publishAt, ...publishedEntry } = entry;
        const saved = await this.published.addEntry(publishedEntry);
        this.pending.delete(id);

        // Call the onPublish callback if registered
        if (this.onPublishCallback) {
          try {
            this.onPublishCallback(saved);
          } catch (err) {
            console.error('[Storage] onPublish callback error:', err);
          }
        }
      }
    }
  }

  async addEntry(entry: Omit<JournalEntry, 'id'>): Promise<JournalEntry> {
    const id = generateEntryId();
    const newEntry: JournalEntry = {
      ...entry,
      id,
      publishAt: Date.now() + this.publishDelayMs,
    };
    this.pending.set(id, newEntry);
    return newEntry;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    // Check pending first, then published
    const pending = this.pending.get(id);
    if (pending) return pending;
    return this.published.getEntry(id);
  }

  async getEntries(limit = 50, offset = 0): Promise<JournalEntry[]> {
    // Only return published entries for public feed
    return this.published.getEntries(limit, offset);
  }

  /**
   * Get entries by pseudonym. If includePending is true, includes unpublished entries.
   */
  async getEntriesByPseudonym(pseudonym: string, limit = 50, includePending = false): Promise<JournalEntry[]> {
    const published = await this.published.getEntriesByPseudonym(pseudonym, limit);

    if (!includePending) {
      return published;
    }

    // Include pending entries for this pseudonym
    const pendingEntries: JournalEntry[] = [];
    for (const entry of this.pending.values()) {
      if (entry.pseudonym === pseudonym) {
        pendingEntries.push(entry);
      }
    }

    // Merge and sort by timestamp (newest first)
    return [...pendingEntries, ...published]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get pending entries for a specific pseudonym
   */
  async getPendingEntriesByPseudonym(pseudonym: string): Promise<JournalEntry[]> {
    const entries: JournalEntry[] = [];
    for (const entry of this.pending.values()) {
      if (entry.pseudonym === pseudonym) {
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  async getEntryCount(): Promise<number> {
    const publishedCount = await this.published.getEntryCount();
    return publishedCount + this.pending.size;
  }

  async deleteEntry(id: string): Promise<void> {
    // Try pending first
    if (this.pending.has(id)) {
      this.pending.delete(id);
      return;
    }
    // Then try published
    await this.published.deleteEntry(id);
  }

  /**
   * Check if an entry is pending (for authorization checks)
   */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  async searchEntries(query: string, limit = 50): Promise<JournalEntry[]> {
    // Search only published entries (pending entries are private)
    return this.published.searchEntries(query, limit);
  }

  /**
   * Stop the publish loop (for cleanup)
   */
  stop() {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Summary methods (delegated to FirestoreStorage)
  // ─────────────────────────────────────────────────────────────

  async addSummary(summary: Omit<Summary, 'id'>): Promise<Summary> {
    return this.published.addSummary(summary);
  }

  async getSummaries(limit = 50): Promise<Summary[]> {
    return this.published.getSummaries(limit);
  }

  async getLastSummaryForPseudonym(pseudonym: string): Promise<Summary | null> {
    return this.published.getLastSummaryForPseudonym(pseudonym);
  }

  async getEntriesInRange(pseudonym: string, startTime: number, endTime: number): Promise<JournalEntry[]> {
    return this.published.getEntriesInRange(pseudonym, startTime, endTime);
  }
}
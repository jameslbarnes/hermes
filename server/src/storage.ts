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
  pseudonym: string;         // Legacy: "Quiet Feather#79c30b" (always present for display fallback)
  handle?: string;           // New: "james" (without @) if user has claimed a handle
  client: 'desktop' | 'mobile' | 'code';
  content: string;
  timestamp: number;
  keywords?: string[]; // Tokenized content for search
  publishAt?: number; // When entry becomes public. If undefined or in past, entry is published.
  isReflection?: boolean; // True for longform markdown reflections
  model?: string; // Model that wrote the entry (e.g., "claude-sonnet-4", "opus-4")
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

export interface DailySummary {
  id: string;
  date: string; // YYYY-MM-DD format
  content: string;
  timestamp: number; // When summary was created
  entryCount: number;
  pseudonyms: string[]; // Pseudonyms who contributed that day
}

export interface Conversation {
  id: string;
  pseudonym: string;
  sourceUrl: string;
  platform: 'chatgpt' | 'claude' | 'gemini' | 'grok';
  title: string;
  content: string;           // Full conversation text (markdown from Firecrawl)
  summary: string;           // AI-generated 2-3 sentence summary
  timestamp: number;
  keywords: string[];        // Tokenized from content for search
  publishAt?: number;        // Staging delay (same as entries)
}

export interface EmailPrefs {
  comments: boolean;         // Receive comment notifications
  digest: boolean;           // Receive daily digest
}

export interface EmailVerification {
  token: string;             // Verification token
  email: string;             // Email being verified
  expiresAt: number;         // Token expiration timestamp
}

export interface User {
  handle: string;            // @james (unique, primary key, stored without @)
  secretKeyHash: string;     // SHA-256 hash of the secret key
  displayName?: string;      // "James"
  pronouns?: string;         // "they/them"
  bio?: string;              // "Building things"
  email?: string;            // For digest/messaging
  emailVerified?: boolean;   // Whether email has been verified via link
  emailPrefs?: EmailPrefs;   // Email notification preferences
  links?: string[];          // External links (Twitter, website, etc.)
  stagingDelayMs?: number;   // How long entries stay in staging (default 1 hour)
  createdAt: number;
  legacyPseudonym?: string;  // "Quiet Feather#79c30b" if migrated from old system
}

export interface Comment {
  id: string;
  entryId?: string;          // The note being commented on (if entry-level comment)
  summaryId?: string;        // The session summary being commented on (if summary-level comment)
  parentCommentId?: string;  // If replying to another comment (for threading)
  handle: string;            // Author of the comment (without @)
  content: string;           // Comment text (max 500 chars)
  mentions?: string[];       // Handles mentioned in the comment (without @)
  timestamp: number;
  publishAt?: number;        // When comment becomes public (for staged publishing)
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
  /** Add a new entry. stagingDelayMs overrides the default staging delay (StagedStorage only). */
  addEntry(entry: Omit<JournalEntry, 'id'>, stagingDelayMs?: number): Promise<JournalEntry>;

  /** Get a single entry by ID */
  getEntry(id: string): Promise<JournalEntry | null>;

  /** Get recent entries (newest first) */
  getEntries(limit?: number, offset?: number): Promise<JournalEntry[]>;

  /** Get entries by pseudonym */
  getEntriesByPseudonym(pseudonym: string, limit?: number): Promise<JournalEntry[]>;

  /** Get entries by handle */
  getEntriesByHandle(handle: string, limit?: number): Promise<JournalEntry[]>;

  /** Search entries by keywords */
  searchEntries(query: string, limit?: number): Promise<JournalEntry[]>;

  /** Get total entry count */
  getEntryCount(): Promise<number>;

  /** Delete an entry by ID */
  deleteEntry(id: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // User methods
  // ─────────────────────────────────────────────────────────────

  /** Create a new user (register handle) */
  createUser(user: Omit<User, 'createdAt'>): Promise<User>;

  /** Get user by handle */
  getUser(handle: string): Promise<User | null>;

  /** Get user by secret key hash */
  getUserByKeyHash(keyHash: string): Promise<User | null>;

  /** Update user profile */
  updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null>;

  /** Check if handle is available */
  isHandleAvailable(handle: string): Promise<boolean>;

  /** Migrate entries from pseudonym to handle (when user claims handle) */
  migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number>;

  /** Get all users with email addresses (for digest sending) */
  getUsersWithEmail(): Promise<User[]>;

  /** Search users by handle prefix (for @mention typeahead) */
  searchUsers(prefix: string, limit?: number): Promise<User[]>;

  // ─────────────────────────────────────────────────────────────
  // Conversation methods
  // ─────────────────────────────────────────────────────────────

  /** Add a new conversation */
  addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation>;

  /** Get a single conversation by ID */
  getConversation(id: string): Promise<Conversation | null>;

  /** Get recent conversations (newest first) */
  getConversations(limit?: number, offset?: number): Promise<Conversation[]>;

  /** Get conversations by pseudonym */
  getConversationsByPseudonym(pseudonym: string, limit?: number): Promise<Conversation[]>;

  /** Search conversations by keywords */
  searchConversations(query: string, limit?: number): Promise<Conversation[]>;

  /** Delete a conversation by ID */
  deleteConversation(id: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Comment methods
  // ─────────────────────────────────────────────────────────────

  /** Add a comment to an entry or summary */
  addComment(comment: Omit<Comment, 'id'>): Promise<Comment>;

  /** Get comments for an entry */
  getCommentsForEntry(entryId: string): Promise<Comment[]>;

  /** Get comments for a summary */
  getCommentsForSummary(summaryId: string): Promise<Comment[]>;

  /** Get comments by handle */
  getCommentsByHandle(handle: string, limit?: number): Promise<Comment[]>;

  /** Get a single comment by ID */
  getCommentById(id: string): Promise<Comment | null>;

  /** Delete a comment */
  deleteComment(id: string): Promise<void>;
}

/**
 * In-memory storage for development/testing
 */
export class MemoryStorage implements Storage {
  private entries: JournalEntry[] = [];
  private users: Map<string, User> = new Map(); // handle -> User
  private nextId = 1;

  async addEntry(entry: Omit<JournalEntry, 'id'>, _stagingDelayMs?: number): Promise<JournalEntry> {
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

  async getEntriesByHandle(handle: string, limit = 50): Promise<JournalEntry[]> {
    return this.entries
      .filter(e => e.handle === handle)
      .sort((a, b) => b.timestamp - a.timestamp)
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

  // ─────────────────────────────────────────────────────────────
  // User methods
  // ─────────────────────────────────────────────────────────────

  async createUser(user: Omit<User, 'createdAt'>): Promise<User> {
    const newUser: User = {
      ...user,
      createdAt: Date.now(),
    };
    this.users.set(user.handle, newUser);
    return newUser;
  }

  async getUser(handle: string): Promise<User | null> {
    return this.users.get(handle) || null;
  }

  async getUserByKeyHash(keyHash: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.secretKeyHash === keyHash) {
        return user;
      }
    }
    return null;
  }

  async updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null> {
    const user = this.users.get(handle);
    if (!user) return null;

    const updated = { ...user, ...updates };
    this.users.set(handle, updated);
    return updated;
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    return !this.users.has(handle);
  }

  async migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number> {
    let count = 0;
    this.entries = this.entries.map(e => {
      if (e.pseudonym === pseudonym) {
        count++;
        return { ...e, handle };
      }
      return e;
    });
    return count;
  }

  async getUsersWithEmail(): Promise<User[]> {
    return Array.from(this.users.values()).filter(u => u.email);
  }

  async searchUsers(prefix: string, limit = 10): Promise<User[]> {
    const lowerPrefix = prefix.toLowerCase();
    return Array.from(this.users.values())
      .filter(u => u.handle.toLowerCase().startsWith(lowerPrefix))
      .slice(0, limit);
  }

  // ─────────────────────────────────────────────────────────────
  // Conversation methods
  // ─────────────────────────────────────────────────────────────

  private conversations: Conversation[] = [];

  async addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation> {
    const newConversation: Conversation = {
      ...conversation,
      id: String(this.nextId++),
    };
    this.conversations.unshift(newConversation);
    return newConversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.find(c => c.id === id) || null;
  }

  async getConversations(limit = 50, offset = 0): Promise<Conversation[]> {
    return this.conversations.slice(offset, offset + limit);
  }

  async getConversationsByPseudonym(pseudonym: string, limit = 50): Promise<Conversation[]> {
    return this.conversations
      .filter(c => c.pseudonym === pseudonym)
      .slice(0, limit);
  }

  async searchConversations(query: string, limit = 50): Promise<Conversation[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    return this.conversations
      .filter(c => {
        return queryKeywords.some(qk => c.keywords.includes(qk));
      })
      .slice(0, limit);
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter(c => c.id !== id);
  }

  // ─────────────────────────────────────────────────────────────
  // Comment methods
  // ─────────────────────────────────────────────────────────────

  private comments: Comment[] = [];

  async addComment(comment: Omit<Comment, 'id'>): Promise<Comment> {
    const newComment: Comment = {
      ...comment,
      id: `c${this.nextId++}`,
    };
    this.comments.unshift(newComment);
    return newComment;
  }

  async getCommentsForEntry(entryId: string): Promise<Comment[]> {
    return this.comments
      .filter(c => c.entryId === entryId)
      .sort((a, b) => a.timestamp - b.timestamp); // oldest first for comments
  }

  async getCommentsForSummary(summaryId: string): Promise<Comment[]> {
    return this.comments
      .filter(c => c.summaryId === summaryId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getCommentsByHandle(handle: string, limit = 50): Promise<Comment[]> {
    return this.comments
      .filter(c => c.handle === handle)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getCommentById(id: string): Promise<Comment | null> {
    return this.comments.find(c => c.id === id) || null;
  }

  async deleteComment(id: string): Promise<void> {
    this.comments = this.comments.filter(c => c.id !== id);
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

  async addEntry(entry: Omit<JournalEntry, 'id'>, _stagingDelayMs?: number): Promise<JournalEntry> {
    const id = generateEntryId();
    const keywords = tokenize(entry.content);
    const newEntry: JournalEntry = { ...entry, id, keywords };

    const docData: Record<string, any> = {
      pseudonym: newEntry.pseudonym,
      client: newEntry.client,
      content: newEntry.content,
      timestamp: newEntry.timestamp,
      keywords,
    };

    if (newEntry.handle) {
      docData.handle = newEntry.handle;
    }

    if (newEntry.isReflection) {
      docData.isReflection = true;
    }

    if (newEntry.model) {
      docData.model = newEntry.model;
    }

    await this.db.collection(this.collection).doc(id).set(docData);

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

  async getEntriesByHandle(handle: string, limit = 50): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('handle', '==', handle)
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
  // User methods
  // ─────────────────────────────────────────────────────────────

  private usersCollection = 'users';

  async createUser(user: Omit<User, 'createdAt'>): Promise<User> {
    const newUser: User = {
      ...user,
      createdAt: Date.now(),
    };

    await this.db.collection(this.usersCollection).doc(user.handle).set({
      secretKeyHash: newUser.secretKeyHash,
      displayName: newUser.displayName || null,
      bio: newUser.bio || null,
      email: newUser.email || null,
      emailPrefs: newUser.emailPrefs || null,
      links: newUser.links || [],
      createdAt: newUser.createdAt,
      legacyPseudonym: newUser.legacyPseudonym || null,
    });

    return newUser;
  }

  async getUser(handle: string): Promise<User | null> {
    const doc = await this.db.collection(this.usersCollection).doc(handle).get();
    if (!doc.exists) return null;
    const data = doc.data()!;

    return {
      handle: doc.id,
      ...data,
    } as User;
  }

  async getUserByKeyHash(keyHash: string): Promise<User | null> {
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('secretKeyHash', '==', keyHash)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    const data = doc.data()!;

    return {
      handle: doc.id,
      ...data,
    } as User;
  }

  async updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null> {
    const userRef = this.db.collection(this.usersCollection).doc(handle);
    const doc = await userRef.get();
    if (!doc.exists) return null;

    await userRef.update(updates);

    const updated = await userRef.get();
    const data = updated.data()!;

    return {
      handle: updated.id,
      ...data,
    } as User;
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    const doc = await this.db.collection(this.usersCollection).doc(handle).get();
    return !doc.exists;
  }

  async migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number> {
    // Get all entries with this pseudonym
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .get();

    // Update each entry with the handle
    const batch = this.db.batch();
    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, { handle });
    });

    await batch.commit();
    return snapshot.size;
  }

  async getUsersWithEmail(): Promise<User[]> {
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('email', '!=', null)
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        handle: doc.id,
        ...data,
      } as User;
    });
  }

  async searchUsers(prefix: string, limit = 10): Promise<User[]> {
    // Firestore prefix search: >= prefix and < prefix + high unicode char
    const endPrefix = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('__name__', '>=', prefix.toLowerCase())
      .where('__name__', '<', endPrefix.toLowerCase())
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        handle: doc.id,
        ...data,
      } as User;
    });
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

  async deleteSummary(id: string): Promise<void> {
    await this.db.collection('summaries').doc(id).delete();
  }

  // ─────────────────────────────────────────────────────────────
  // Daily Summary methods
  // ─────────────────────────────────────────────────────────────

  async addDailySummary(summary: Omit<DailySummary, 'id'>): Promise<DailySummary> {
    const id = `daily-${summary.date}`;
    const newSummary: DailySummary = { ...summary, id };

    await this.db.collection('dailySummaries').doc(id).set({
      date: newSummary.date,
      content: newSummary.content,
      timestamp: newSummary.timestamp,
      entryCount: newSummary.entryCount,
      pseudonyms: newSummary.pseudonyms,
    });

    return newSummary;
  }

  async getDailySummaries(limit = 30): Promise<DailySummary[]> {
    const snapshot = await this.db
      .collection('dailySummaries')
      .orderBy('date', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as DailySummary));
  }

  async getDailySummary(date: string): Promise<DailySummary | null> {
    const doc = await this.db.collection('dailySummaries').doc(`daily-${date}`).get();
    if (!doc.exists) return null;
    return {
      id: doc.id,
      ...doc.data(),
    } as DailySummary;
  }

  async deleteDailySummary(date: string): Promise<void> {
    await this.db.collection('dailySummaries').doc(`daily-${date}`).delete();
  }

  async getEntriesForDate(date: string): Promise<JournalEntry[]> {
    // Parse date and get start/end timestamps
    const startOfDay = new Date(date + 'T00:00:00Z').getTime();
    const endOfDay = new Date(date + 'T23:59:59.999Z').getTime();

    const snapshot = await this.db
      .collection(this.collection)
      .where('timestamp', '>=', startOfDay)
      .where('timestamp', '<=', endOfDay)
      .orderBy('timestamp', 'asc')
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  // ─────────────────────────────────────────────────────────────
  // Conversation methods
  // ─────────────────────────────────────────────────────────────

  private conversationsCollection = 'imported_conversations';

  async addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation> {
    const id = generateEntryId();
    const newConversation: Conversation = { ...conversation, id };

    await this.db.collection(this.conversationsCollection).doc(id).set({
      pseudonym: newConversation.pseudonym,
      sourceUrl: newConversation.sourceUrl,
      platform: newConversation.platform,
      title: newConversation.title,
      content: newConversation.content,
      summary: newConversation.summary,
      timestamp: newConversation.timestamp,
      keywords: newConversation.keywords,
    });

    return newConversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const doc = await this.db.collection(this.conversationsCollection).doc(id).get();
    if (!doc.exists) return null;
    return {
      id: doc.id,
      ...doc.data(),
    } as Conversation;
  }

  async getConversations(limit = 50, offset = 0): Promise<Conversation[]> {
    const snapshot = await this.db
      .collection(this.conversationsCollection)
      .orderBy('timestamp', 'desc')
      .limit(limit + offset)
      .get();

    const conversations: Conversation[] = [];
    snapshot.docs.slice(offset).forEach(doc => {
      conversations.push({
        id: doc.id,
        ...doc.data(),
      } as Conversation);
    });

    return conversations;
  }

  async getConversationsByPseudonym(pseudonym: string, limit = 50): Promise<Conversation[]> {
    const snapshot = await this.db
      .collection(this.conversationsCollection)
      .where('pseudonym', '==', pseudonym)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Conversation));
  }

  async searchConversations(query: string, limit = 50): Promise<Conversation[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    // Firestore array-contains-any supports up to 30 values
    const searchKeywords = queryKeywords.slice(0, 30);

    const snapshot = await this.db
      .collection(this.conversationsCollection)
      .where('keywords', 'array-contains-any', searchKeywords)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Conversation));
  }

  async deleteConversation(id: string): Promise<void> {
    await this.db.collection(this.conversationsCollection).doc(id).delete();
  }

  // ─────────────────────────────────────────────────────────────
  // Comment methods
  // ─────────────────────────────────────────────────────────────

  private commentsCollection = 'comments';

  async addComment(comment: Omit<Comment, 'id'>): Promise<Comment> {
    const id = generateEntryId();
    const newComment: Comment = { ...comment, id };

    await this.db.collection(this.commentsCollection).doc(id).set({
      entryId: newComment.entryId || null,
      summaryId: newComment.summaryId || null,
      parentCommentId: newComment.parentCommentId || null,
      handle: newComment.handle,
      content: newComment.content,
      timestamp: newComment.timestamp,
    });

    return newComment;
  }

  async getCommentsForSummary(summaryId: string): Promise<Comment[]> {
    const snapshot = await this.db
      .collection(this.commentsCollection)
      .where('summaryId', '==', summaryId)
      .orderBy('timestamp', 'asc')
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Comment));
  }

  async getCommentsForEntry(entryId: string): Promise<Comment[]> {
    const snapshot = await this.db
      .collection(this.commentsCollection)
      .where('entryId', '==', entryId)
      .orderBy('timestamp', 'asc')
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Comment));
  }

  async getCommentsByHandle(handle: string, limit = 50): Promise<Comment[]> {
    const snapshot = await this.db
      .collection(this.commentsCollection)
      .where('handle', '==', handle)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Comment));
  }

  async getCommentById(id: string): Promise<Comment | null> {
    const doc = await this.db.collection(this.commentsCollection).doc(id).get();
    if (!doc.exists) {
      return null;
    }
    return {
      id: doc.id,
      ...doc.data(),
    } as Comment;
  }

  async deleteComment(id: string): Promise<void> {
    await this.db.collection(this.commentsCollection).doc(id).delete();
  }
}

/**
 * Staged storage: entries live in memory for 1 hour before publishing to Firestore
 */
export class StagedStorage implements Storage {
  private pending: Map<string, JournalEntry> = new Map();
  private pendingConversations: Map<string, Conversation> = new Map();
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

    // Publish ready entries
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

    // Publish ready conversations
    for (const [id, conversation] of this.pendingConversations) {
      if (conversation.publishAt && conversation.publishAt <= now) {
        // Move to Firestore without publishAt field
        const { publishAt, ...publishedConversation } = conversation;
        await this.published.addConversation(publishedConversation);
        this.pendingConversations.delete(id);
      }
    }
  }

  async addEntry(entry: Omit<JournalEntry, 'id'>, stagingDelayMs?: number): Promise<JournalEntry> {
    const id = generateEntryId();
    const delay = stagingDelayMs ?? this.publishDelayMs;
    const newEntry: JournalEntry = {
      ...entry,
      id,
      publishAt: Date.now() + delay,
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

  async getEntriesByHandle(handle: string, limit = 50): Promise<JournalEntry[]> {
    return this.published.getEntriesByHandle(handle, limit);
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

  /**
   * Publish a pending entry immediately (move from pending to Firestore)
   * Returns the published entry, or null if entry was not found in pending
   */
  async publishEntry(id: string): Promise<JournalEntry | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;

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

    return saved;
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

  /**
   * Get all pending state for recovery (entries and conversations)
   */
  getPendingState(): { entries: JournalEntry[]; conversations: Conversation[] } {
    return {
      entries: Array.from(this.pending.values()),
      conversations: Array.from(this.pendingConversations.values()),
    };
  }

  /**
   * Restore pending state from recovery (entries and conversations)
   */
  restorePendingState(state: { entries: JournalEntry[]; conversations: Conversation[] }): void {
    for (const entry of state.entries) {
      this.pending.set(entry.id, entry);
    }
    for (const conversation of state.conversations) {
      this.pendingConversations.set(conversation.id, conversation);
    }
    console.log(`[Storage] Restored ${state.entries.length} pending entries, ${state.conversations.length} pending conversations`);
  }

  // ─────────────────────────────────────────────────────────────
  // User methods (delegated to FirestoreStorage)
  // ─────────────────────────────────────────────────────────────

  async createUser(user: Omit<User, 'createdAt'>): Promise<User> {
    return this.published.createUser(user);
  }

  async getUser(handle: string): Promise<User | null> {
    return this.published.getUser(handle);
  }

  async getUserByKeyHash(keyHash: string): Promise<User | null> {
    return this.published.getUserByKeyHash(keyHash);
  }

  async updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null> {
    return this.published.updateUser(handle, updates);
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    return this.published.isHandleAvailable(handle);
  }

  async migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number> {
    return this.published.migrateEntriesToHandle(pseudonym, handle);
  }

  async getUsersWithEmail(): Promise<User[]> {
    return this.published.getUsersWithEmail();
  }

  async searchUsers(prefix: string, limit = 10): Promise<User[]> {
    return this.published.searchUsers(prefix, limit);
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

  async deleteSummary(id: string): Promise<void> {
    return this.published.deleteSummary(id);
  }

  // Daily summary methods
  async addDailySummary(summary: Omit<DailySummary, 'id'>): Promise<DailySummary> {
    return this.published.addDailySummary(summary);
  }

  async getDailySummaries(limit = 30): Promise<DailySummary[]> {
    return this.published.getDailySummaries(limit);
  }

  async getDailySummary(date: string): Promise<DailySummary | null> {
    return this.published.getDailySummary(date);
  }

  async deleteDailySummary(date: string): Promise<void> {
    return this.published.deleteDailySummary(date);
  }

  async getEntriesForDate(date: string): Promise<JournalEntry[]> {
    return this.published.getEntriesForDate(date);
  }

  // ─────────────────────────────────────────────────────────────
  // Conversation methods (with staging support)
  // ─────────────────────────────────────────────────────────────

  async addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation> {
    // Conversations publish immediately (user intentionally imported them)
    return this.published.addConversation(conversation);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    // Check pending first, then published
    const pending = this.pendingConversations.get(id);
    if (pending) return pending;
    return this.published.getConversation(id);
  }

  async getConversations(limit = 50, offset = 0): Promise<Conversation[]> {
    // Only return published conversations for public feed
    return this.published.getConversations(limit, offset);
  }

  /**
   * Get conversations by pseudonym. If includePending is true, includes unpublished conversations.
   */
  async getConversationsByPseudonym(pseudonym: string, limit = 50, includePending = false): Promise<Conversation[]> {
    const published = await this.published.getConversationsByPseudonym(pseudonym, limit);

    if (!includePending) {
      return published;
    }

    // Include pending conversations for this pseudonym
    const pendingConversations: Conversation[] = [];
    for (const conversation of this.pendingConversations.values()) {
      if (conversation.pseudonym === pseudonym) {
        pendingConversations.push(conversation);
      }
    }

    // Merge and sort by timestamp (newest first)
    return [...pendingConversations, ...published]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get pending conversations for a specific pseudonym
   */
  async getPendingConversationsByPseudonym(pseudonym: string): Promise<Conversation[]> {
    const conversations: Conversation[] = [];
    for (const conversation of this.pendingConversations.values()) {
      if (conversation.pseudonym === pseudonym) {
        conversations.push(conversation);
      }
    }
    return conversations.sort((a, b) => b.timestamp - a.timestamp);
  }

  async searchConversations(query: string, limit = 50): Promise<Conversation[]> {
    // Search only published conversations (pending are private)
    return this.published.searchConversations(query, limit);
  }

  async deleteConversation(id: string): Promise<void> {
    // Try pending first
    if (this.pendingConversations.has(id)) {
      this.pendingConversations.delete(id);
      return;
    }
    // Then try published
    await this.published.deleteConversation(id);
  }

  /**
   * Check if a conversation is pending (for authorization checks)
   */
  isConversationPending(id: string): boolean {
    return this.pendingConversations.has(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Comment methods (with staging support)
  // ─────────────────────────────────────────────────────────────

  async addComment(comment: Omit<Comment, 'id'>): Promise<Comment> {
    const id = generateEntryId();
    const newComment: Comment = { ...comment, id };

    // Comments publish immediately (user-initiated, no staging needed)
    await this.published.addComment(newComment);

    return newComment;
  }

  async getCommentsForEntry(entryId: string): Promise<Comment[]> {
    return this.published.getCommentsForEntry(entryId);
  }

  async getCommentsForSummary(summaryId: string): Promise<Comment[]> {
    return this.published.getCommentsForSummary(summaryId);
  }

  async getCommentsByHandle(handle: string, limit = 50): Promise<Comment[]> {
    return this.published.getCommentsByHandle(handle, limit);
  }

  async getCommentById(id: string): Promise<Comment | null> {
    return this.published.getCommentById(id);
  }

  async deleteComment(id: string): Promise<void> {
    await this.published.deleteComment(id);
  }
}
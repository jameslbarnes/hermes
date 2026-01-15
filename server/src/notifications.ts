/**
 * Email Notifications Service
 *
 * Handles:
 * - Real-time comment notifications
 * - Daily digest generation and sending
 */

import sgMail from '@sendgrid/mail';
import Anthropic from '@anthropic-ai/sdk';

// Simple email client interface
interface EmailClient {
  send(params: { from: string; to: string; subject: string; html: string }): Promise<void>;
}

// Create SendGrid email client
export function createSendGridClient(apiKey: string): EmailClient {
  sgMail.setApiKey(apiKey);
  return {
    async send({ from, to, subject, html }) {
      await sgMail.send({ from, to, subject, html });
    }
  };
}
import { Storage, User, JournalEntry, Comment } from './storage';
import jwt from 'jsonwebtoken';

// Rate limiting: max emails per user per day
const MAX_EMAILS_PER_USER_PER_DAY = 10;
const emailCountByUser = new Map<string, number>();

// Reset email counts daily
setInterval(() => {
  emailCountByUser.clear();
}, 24 * 60 * 60 * 1000);

function canSendEmailTo(handle: string): boolean {
  const count = emailCountByUser.get(handle) || 0;
  if (count >= MAX_EMAILS_PER_USER_PER_DAY) return false;
  emailCountByUser.set(handle, count + 1);
  return true;
}

export interface NotificationService {
  notifyCommentPosted(comment: Comment, entry: JournalEntry): Promise<void>;
  sendDailyDigests(): Promise<{ sent: number; failed: number }>;
  sendVerificationEmail(handle: string, email: string): Promise<boolean>;
}

interface NotificationConfig {
  storage: Storage;
  emailClient: EmailClient | null;
  anthropic: Anthropic | null;
  fromEmail: string;
  baseUrl: string;
  jwtSecret: string;
}

/**
 * Create a notification service
 */
export function createNotificationService(config: NotificationConfig): NotificationService {
  const { storage, emailClient, anthropic, fromEmail, baseUrl, jwtSecret } = config;

  /**
   * Generate unsubscribe token for email footer
   */
  function generateUnsubscribeToken(handle: string, type: 'comments' | 'digest'): string {
    return jwt.sign({ handle, type }, jwtSecret, { expiresIn: '30d' });
  }

  /**
   * Render comment notification email HTML
   */
  function renderCommentEmail(
    comment: Comment,
    entry: JournalEntry,
    entryOwner: User,
    unsubscribeToken: string
  ): string {
    const entryPreview = entry.content.length > 200
      ? entry.content.slice(0, 200) + '...'
      : entry.content;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { color: #6b6b6b; font-size: 14px; margin-bottom: 20px; }
    .entry { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .entry-label { font-size: 12px; color: #6b6b6b; margin-bottom: 8px; }
    .comment { background: #fff; border-left: 3px solid #7c5cbf; padding: 15px; margin-bottom: 20px; }
    .comment-author { font-weight: bold; color: #7c5cbf; }
    .footer { font-size: 12px; color: #999; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
    .footer a { color: #999; }
    .btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="header">New comment on your Hermes entry</div>

  <div class="entry">
    <div class="entry-label">Your entry:</div>
    ${entryPreview}
  </div>

  <div class="comment">
    <div class="comment-author">@${comment.handle} commented:</div>
    <p>${comment.content}</p>
  </div>

  <a href="${baseUrl}" class="btn">View on Hermes</a>

  <div class="footer">
    <p>You're receiving this because someone commented on your entry.</p>
    <a href="${baseUrl}/unsubscribe?token=${unsubscribeToken}&type=comments">Unsubscribe from comment notifications</a>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Render daily digest email HTML
   */
  function renderDigestEmail(
    user: User,
    digestContent: string,
    relatedEntries: JournalEntry[],
    unsubscribeToken: string
  ): string {
    const relatedHtml = relatedEntries.length > 0
      ? `
        <div class="related">
          <div class="section-label">From others in the notebook:</div>
          ${relatedEntries.map(e => {
            const author = e.handle ? `@${e.handle}` : e.pseudonym;
            const preview = e.content.length > 150 ? e.content.slice(0, 150) + '...' : e.content;
            return `<a href="${baseUrl}/e/${e.id}" style="text-decoration: none; color: inherit;"><div class="related-entry"><span class="author">${author}:</span> ${preview}</div></a>`;
          }).join('')}
        </div>
      `
      : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { color: #7c5cbf; font-size: 18px; font-weight: bold; margin-bottom: 20px; }
    .digest { font-size: 16px; margin-bottom: 30px; }
    .section-label { font-size: 12px; color: #6b6b6b; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    .related { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
    .related-entry { background: #f9f9f9; padding: 12px; border-radius: 6px; margin-bottom: 10px; font-size: 14px; }
    .author { color: #7c5cbf; font-weight: 500; }
    .footer { font-size: 12px; color: #999; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
    .footer a { color: #999; }
    .btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="header">Your Hermes Daily Digest</div>

  <div class="digest">
    ${digestContent}
  </div>

  ${relatedHtml}

  <a href="${baseUrl}" class="btn">Open Hermes</a>

  <div class="footer">
    <p>Your daily digest from Hermes.</p>
    <a href="${baseUrl}/unsubscribe?token=${unsubscribeToken}&type=digest">Unsubscribe from daily digest</a>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate email verification token
   */
  function generateVerificationToken(handle: string, email: string): string {
    return jwt.sign({ handle, email, purpose: 'verify-email' }, jwtSecret, { expiresIn: '24h' });
  }

  /**
   * Render verification email HTML
   */
  function renderVerificationEmail(handle: string, verificationToken: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { color: #7c5cbf; font-size: 18px; font-weight: bold; margin-bottom: 20px; }
    .message { margin-bottom: 30px; }
    .btn { display: inline-block; background: #7c5cbf; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; }
    .footer { font-size: 12px; color: #999; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="header">Verify your email for Hermes</div>

  <div class="message">
    <p>Hi @${handle},</p>
    <p>Click the button below to verify your email address and start receiving notifications from Hermes.</p>
    <p>This link will expire in 24 hours.</p>
  </div>

  <a href="${baseUrl}/api/verify-email?token=${verificationToken}" class="btn">Verify Email</a>

  <div class="footer">
    <p>If you didn't request this, you can safely ignore this email.</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Simple keyword extraction for finding related entries
   */
  function extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'this',
      'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
      'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all',
      'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
      'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very', 'just', 'about',
    ]);

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    return new Set(words);
  }

  /**
   * Find entries related to a user's recent activity
   */
  async function findRelatedEntries(
    userHandle: string
  ): Promise<{ userEntries: JournalEntry[]; relatedEntries: JournalEntry[] }> {
    // Get user's entries from last 7 days
    const userEntries = await storage.getEntriesByHandle(userHandle, 20);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentUserEntries = userEntries.filter(e => e.timestamp > sevenDaysAgo);

    if (recentUserEntries.length === 0) {
      return { userEntries: [], relatedEntries: [] };
    }

    // Extract keywords from user's entries
    const userKeywords = new Set<string>();
    for (const entry of recentUserEntries) {
      for (const kw of extractKeywords(entry.content)) {
        userKeywords.add(kw);
      }
    }

    // Get recent entries from others (last 2 days)
    const allRecent = await storage.getEntries(100);
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const othersEntries = allRecent.filter(e =>
      e.handle !== userHandle &&
      e.timestamp > twoDaysAgo
    );

    // Score by keyword overlap
    const scored = othersEntries.map(entry => {
      const entryKeywords = extractKeywords(entry.content);
      let overlap = 0;
      for (const kw of entryKeywords) {
        if (userKeywords.has(kw)) overlap++;
      }
      return { entry, score: overlap };
    });

    // Return top 5 related entries
    const relatedEntries = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => s.entry);

    return { userEntries: recentUserEntries, relatedEntries };
  }

  /**
   * Generate digest content using Claude
   */
  async function generateDigestContent(
    userHandle: string,
    userEntries: JournalEntry[],
    relatedEntries: JournalEntry[]
  ): Promise<string | null> {
    if (!anthropic) {
      console.warn('[Digest] No Anthropic client configured');
      return null;
    }

    // Prepare entry summaries (truncated to fit token budget)
    const userText = userEntries
      .slice(0, 3)
      .map(e => `- ${e.content.slice(0, 200)}`)
      .join('\n');

    const relatedText = relatedEntries
      .slice(0, 5)
      .map(e => {
        const author = e.handle ? `@${e.handle}` : e.pseudonym;
        return `[${author}] ${e.content.slice(0, 150)}`;
      })
      .join('\n');

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Write a brief digest (3-4 sentences) for @${userHandle} focused on what OTHERS have been writing.

For context, here's what @${userHandle} has been thinking about:
${userText}

Here's what others have written that might interest them:
${relatedText}

Focus primarily on surfacing what others are exploring—their ideas, questions, and observations. Briefly note any resonance with @${userHandle}'s interests, but the main value is discovery of others' thoughts. Be specific about what others said. No greeting or sign-off.`,
        }],
      });

      if (response.content[0].type === 'text') {
        return response.content[0].text;
      }
      return null;
    } catch (err) {
      console.error('[Digest] Claude API error:', err);
      return null;
    }
  }

  return {
    /**
     * Send notification when someone comments on an entry
     */
    async notifyCommentPosted(comment: Comment, entry: JournalEntry): Promise<void> {
      // Don't notify on self-comments
      if (comment.handle === entry.handle) {
        return;
      }

      // Entry must have a handle to notify (legacy entries can't receive notifications)
      if (!entry.handle) {
        return;
      }

      // Get entry owner
      const entryOwner = await storage.getUser(entry.handle);
      if (!entryOwner?.email) {
        return; // No email registered
      }

      // Only send to verified emails
      if (!entryOwner.emailVerified) {
        return; // Email not verified
      }

      // Check email preferences
      if (entryOwner.emailPrefs && !entryOwner.emailPrefs.comments) {
        return; // User disabled comment notifications
      }

      // Rate limiting
      if (!canSendEmailTo(entryOwner.handle)) {
        console.log(`[Notify] Rate limited for @${entryOwner.handle}`);
        return;
      }

      if (!emailClient) {
        console.warn('[Notify] No email client configured');
        return;
      }

      try {
        const unsubscribeToken = generateUnsubscribeToken(entryOwner.handle, 'comments');

        await emailClient.send({
          from: `Hermes <${fromEmail}>`,
          to: entryOwner.email,
          subject: `@${comment.handle} commented on your entry`,
          html: renderCommentEmail(comment, entry, entryOwner, unsubscribeToken),
        });

        console.log(`[Notify] Comment notification sent to @${entryOwner.handle}`);
      } catch (err) {
        console.error(`[Notify] Failed to send to @${entryOwner.handle}:`, err);
        // Fire-and-forget: don't throw
      }
    },

    /**
     * Send daily digests to all users with email
     */
    async sendDailyDigests(): Promise<{ sent: number; failed: number }> {
      let sent = 0;
      let failed = 0;

      if (!emailClient) {
        console.warn('[Digest] No email client configured');
        return { sent, failed };
      }

      const usersWithEmail = await storage.getUsersWithEmail();
      console.log(`[Digest] Processing ${usersWithEmail.length} users with email`);

      for (const user of usersWithEmail) {
        // Only send to verified emails
        if (!user.emailVerified) {
          continue; // Email not verified
        }

        // Check email preferences
        if (user.emailPrefs && !user.emailPrefs.digest) {
          continue; // User disabled digest
        }

        try {
          const { userEntries, relatedEntries } = await findRelatedEntries(user.handle);

          // Skip if no recent activity AND no related entries
          if (userEntries.length === 0 && relatedEntries.length === 0) {
            continue;
          }

          const digestContent = await generateDigestContent(
            user.handle,
            userEntries,
            relatedEntries
          );

          if (!digestContent) {
            continue; // Claude returned empty or failed
          }

          const unsubscribeToken = generateUnsubscribeToken(user.handle, 'digest');

          await emailClient.send({
            from: `Hermes <${fromEmail}>`,
            to: user.email!,
            subject: 'Your Hermes Daily Digest',
            html: renderDigestEmail(user, digestContent, relatedEntries, unsubscribeToken),
          });

          sent++;
          console.log(`[Digest] Sent to @${user.handle}`);

          // Small delay between sends to avoid rate limits
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          console.error(`[Digest] Failed for @${user.handle}:`, err);
          failed++;
          // Continue to next user
        }
      }

      return { sent, failed };
    },

    /**
     * Send verification email when user sets/updates their email
     */
    async sendVerificationEmail(handle: string, email: string): Promise<boolean> {
      if (!emailClient) {
        console.warn('[Verify] No email client configured');
        return false;
      }

      // Rate limiting (counts against daily email limit)
      if (!canSendEmailTo(handle)) {
        console.log(`[Verify] Rate limited for @${handle}`);
        return false;
      }

      try {
        const verificationToken = generateVerificationToken(handle, email);

        await emailClient.send({
          from: `Hermes <${fromEmail}>`,
          to: email,
          subject: 'Verify your email for Hermes',
          html: renderVerificationEmail(handle, verificationToken),
        });

        console.log(`[Verify] Verification email sent to ${email} for @${handle}`);
        return true;
      } catch (err: any) {
        console.error(`[Verify] Failed to send verification email to ${email}`);
        console.error(`[Verify] From: ${fromEmail}`);
        console.error(`[Verify] Error:`, err?.response?.body || err?.message || err);
        return false;
      }
    },
  };
}

/**
 * Verify email verification token
 */
export function verifyEmailToken(
  token: string,
  jwtSecret: string
): { handle: string; email: string } | null {
  try {
    const decoded = jwt.verify(token, jwtSecret) as {
      handle: string;
      email: string;
      purpose: string;
    };
    if (decoded.purpose !== 'verify-email') {
      return null;
    }
    return { handle: decoded.handle, email: decoded.email };
  } catch {
    return null;
  }
}

/**
 * Verify and decode an unsubscribe token
 */
export function verifyUnsubscribeToken(
  token: string,
  jwtSecret: string
): { handle: string; type: 'comments' | 'digest' } | null {
  try {
    const decoded = jwt.verify(token, jwtSecret) as {
      handle: string;
      type: 'comments' | 'digest';
    };
    return decoded;
  } catch {
    return null;
  }
}

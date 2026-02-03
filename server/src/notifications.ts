/**
 * Email Notifications Service
 *
 * Handles:
 * - Daily digest generation and sending
 * - Email verification
 * - Addressed entry notifications
 */

import sgMail from '@sendgrid/mail';
import Anthropic from '@anthropic-ai/sdk';

// Simple email client interface
export interface EmailClient {
  send(params: {
    from: string;
    to: string;
    subject: string;
    html: string;
    cc?: string;
    replyTo?: string;
  }): Promise<void>;
}

// Create SendGrid email client
export function createSendGridClient(apiKey: string): EmailClient {
  sgMail.setApiKey(apiKey);
  return {
    async send({ from, to, subject, html, cc, replyTo }) {
      await sgMail.send({
        from,
        to,
        subject,
        html,
        ...(cc ? { cc } : {}),
        ...(replyTo ? { replyTo } : {}),
      });
    }
  };
}
import { Storage, User, JournalEntry } from './storage';
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
  sendDailyDigests(): Promise<{ sent: number; failed: number }>;
  sendVerificationEmail(handle: string, email: string): Promise<boolean>;
  notifyAddressedEntry?(entry: JournalEntry, recipient: User, author?: User): Promise<void>;
  notifyNewFollower?(follower: User, followed: User): Promise<void>;
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

    // Build prompt for Claude deep link
    const relatedSummary = relatedEntries.map(e => {
      const author = e.handle ? `@${e.handle}` : e.pseudonym;
      return `${author}: ${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`;
    }).join('\n\n');

    const claudePrompt = `Here's my Hermes daily digest:

${digestContent}

Recent entries from others:
${relatedSummary}

What stands out to you? Any connections or threads worth exploring?`;

    const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(claudePrompt)}`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.7; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .digest { font-size: 16px; margin-bottom: 30px; }
    .related-entry { background: #f9f7ff; padding: 14px 16px; border-radius: 6px; margin-bottom: 10px; font-size: 15px; }
    .author { color: #7c5cbf; font-weight: 600; }
    a.btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 22px; text-decoration: none; border-radius: 6px; font-family: Georgia, serif; }
    .footer { font-size: 13px; color: #999; margin-top: 40px; }
    .footer a { color: #999; }
  </style>
</head>
<body>
  <p>Hey @${user.handle},</p>

  <div class="digest">
    ${digestContent}
  </div>

  ${relatedHtml}

  <p><a href="${claudeUrl}" class="btn">Discuss with Claude</a></p>

  <div class="footer">
    &mdash;<br>
    hermes.teleport.computer &middot; <a href="${baseUrl}/unsubscribe?token=${unsubscribeToken}&type=digest">unsubscribe</a>
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
    body { font-family: Georgia, serif; line-height: 1.7; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    a.btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 22px; text-decoration: none; border-radius: 6px; font-family: Georgia, serif; }
    .footer { font-size: 13px; color: #999; margin-top: 40px; }
  </style>
</head>
<body>
  <p>Hey @${handle},</p>

  <p>Click below to verify your email. This lets you receive messages from other people on Hermes.</p>

  <p><a href="${baseUrl}/api/verify-email?token=${verificationToken}" class="btn">Verify email</a></p>

  <p style="font-size: 14px; color: #666;">This link expires in 24 hours.</p>

  <div class="footer">
    &mdash;<br>
    hermes.teleport.computer
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
            subject: `What's happening on Hermes`,
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

    /**
     * Notify a user when they're addressed in an entry
     */
    async notifyAddressedEntry(entry: JournalEntry, recipient: User, author?: User): Promise<void> {
      console.log(`[Notify] Entry addressed to @${recipient.handle} by @${entry.handle || entry.pseudonym}`);

      // Don't notify if user doesn't have email or hasn't verified
      if (!recipient.email || !recipient.emailVerified) {
        console.log(`[Notify] Skipping: @${recipient.handle} has no verified email`);
        return;
      }

      // Check email preferences (use comments pref for now, could add separate pref later)
      if (recipient.emailPrefs && !recipient.emailPrefs.comments) {
        console.log(`[Notify] Skipping: @${recipient.handle} disabled notifications`);
        return;
      }

      // Rate limiting
      if (!canSendEmailTo(recipient.handle)) {
        console.log(`[Notify] Rate limited for @${recipient.handle}`);
        return;
      }

      if (!emailClient) {
        console.warn('[Notify] No email client configured');
        return;
      }

      try {
        const authorName = entry.handle ? `@${entry.handle}` : entry.pseudonym;
        const unsubscribeToken = generateUnsubscribeToken(recipient.handle, 'comments');

        // CC the author if they have a verified email
        const authorCc = author?.email && author?.emailVerified ? author.email : undefined;
        const authorReplyTo = authorCc; // Let recipient reply directly to the author

        await emailClient.send({
          from: `Hermes <${fromEmail}>`,
          to: recipient.email,
          subject: `${authorName} wrote you something`,
          html: renderAddressedEntryEmail(entry, authorName, recipient, unsubscribeToken),
          cc: authorCc,
          replyTo: authorReplyTo,
        });

        console.log(`[Notify] Addressed entry notification sent to @${recipient.handle}${authorCc ? ` (cc: ${authorCc})` : ''}`);
      } catch (err) {
        console.error(`[Notify] Failed to send to @${recipient.handle}:`, err);
      }
    },

    /**
     * Notify a user when someone follows them
     */
    async notifyNewFollower(follower: User, followed: User): Promise<void> {
      console.log(`[Notify] @${follower.handle} followed @${followed.handle}`);

      if (!followed.email || !followed.emailVerified) {
        console.log(`[Notify] Skipping follow notification: @${followed.handle} has no verified email`);
        return;
      }

      // Use comments pref for follow notifications too
      if (followed.emailPrefs && !followed.emailPrefs.comments) {
        console.log(`[Notify] Skipping: @${followed.handle} disabled notifications`);
        return;
      }

      if (!canSendEmailTo(followed.handle)) {
        console.log(`[Notify] Rate limited for @${followed.handle}`);
        return;
      }

      if (!emailClient) {
        console.warn('[Notify] No email client configured');
        return;
      }

      try {
        const unsubscribeToken = generateUnsubscribeToken(followed.handle, 'comments');

        await emailClient.send({
          from: `Hermes <${fromEmail}>`,
          to: followed.email,
          subject: `@${follower.handle} started following you`,
          html: renderFollowEmail(follower, followed, unsubscribeToken),
        });

        console.log(`[Notify] Follow notification sent to @${followed.handle}`);
      } catch (err) {
        console.error(`[Notify] Failed to send follow notification to @${followed.handle}:`, err);
      }
    },
  };

  /**
   * Render addressed entry notification email HTML
   */
  function renderAddressedEntryEmail(
    entry: JournalEntry,
    author: string,
    recipient: User,
    unsubscribeToken: string
  ): string {
    const contentPreview = entry.content.length > 500
      ? entry.content.slice(0, 500) + '...'
      : entry.content;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.7; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .quote { border-left: 3px solid #7c5cbf; padding: 12px 16px; margin: 20px 0; background: #f9f7ff; font-size: 16px; }
    a.btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 22px; text-decoration: none; border-radius: 6px; font-family: Georgia, serif; }
    .footer { font-size: 13px; color: #999; margin-top: 40px; }
    .footer a { color: #999; }
  </style>
</head>
<body>
  <p>Hey,</p>

  <p>${author} wrote this for you on Hermes:</p>

  <div class="quote">${contentPreview}</div>

  <p><a href="${baseUrl}/e/${entry.id}" class="btn">View on Hermes</a></p>

  <div class="footer">
    &mdash;<br>
    hermes.teleport.computer &middot; <a href="${baseUrl}/unsubscribe?token=${unsubscribeToken}&type=comments">unsubscribe</a>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Render follow notification email HTML
   */
  function renderFollowEmail(
    follower: User,
    followed: User,
    unsubscribeToken: string
  ): string {
    const bioHtml = follower.bio
      ? `<p style="color: #555; font-style: italic;">Their bio: "${follower.bio}"</p>`
      : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.7; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    a.btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 22px; text-decoration: none; border-radius: 6px; font-family: Georgia, serif; }
    .footer { font-size: 13px; color: #999; margin-top: 40px; }
    .footer a { color: #999; }
  </style>
</head>
<body>
  <p>Hey @${followed.handle},</p>

  <p>@${follower.handle} just started following you on Hermes.</p>

  ${bioHtml}

  <p>You can check out their profile or write them something.</p>

  <p><a href="${baseUrl}/@${follower.handle}" class="btn">View @${follower.handle}'s profile</a></p>

  <div class="footer">
    &mdash;<br>
    hermes.teleport.computer &middot; <a href="${baseUrl}/unsubscribe?token=${unsubscribeToken}&type=comments">unsubscribe</a>
  </div>
</body>
</html>
    `.trim();
  }
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

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
    to: string | string[];
    subject: string;
    html: string;
    cc?: string | string[];
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

export function canSendEmailTo(handle: string): boolean {
  const count = emailCountByUser.get(handle) || 0;
  if (count >= MAX_EMAILS_PER_USER_PER_DAY) return false;
  emailCountByUser.set(handle, count + 1);
  return true;
}

export interface NotificationService {
  sendDailyDigests(): Promise<{ sent: number; failed: number }>;
  sendTestDigest(handle: string): Promise<{ html: string; subject: string } | null>;
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
 * Generate unsubscribe token for email footer
 */
export function generateUnsubscribeToken(handle: string, type: 'comments' | 'digest', jwtSecret: string): string {
  return jwt.sign({ handle, type }, jwtSecret, { expiresIn: '30d' });
}

/**
 * Create a notification service
 */
export function createNotificationService(config: NotificationConfig): NotificationService {
  const { storage, emailClient, anthropic, fromEmail, baseUrl, jwtSecret } = config;

  function fallbackSubject(followedEntries: JournalEntry[]): string {
    if (followedEntries.length > 0) {
      const authors = [...new Set(followedEntries.map(e => `@${e.handle}`))];
      if (authors.length === 1) return `What ${authors[0]} wrote today`;
      if (authors.length === 2) return `What ${authors[0]} & ${authors[1]} wrote today`;
      return `What ${authors[0]}, ${authors[1]} & others wrote today`;
    }
    return `What's happening on Hermes`;
  }

  /**
   * Render daily digest email HTML
   */
  function renderDigestEmail(
    user: User,
    digestContent: string,
    question: string,
    newsItems: { title: string; url: string; summary: string }[],
    followedEntries: JournalEntry[],
    discoveryEntries: JournalEntry[],
    unsubscribeToken: string
  ): string {
    const greeting = user.displayName || `@${user.handle}`;

    // Followed entries section
    const followedHtml = followedEntries.length > 0
      ? `
        <div class="section">
          <div class="section-label">From people you follow</div>
          ${followedEntries.slice(0, 4).map(e => {
            const author = e.handle ? `@${e.handle}` : e.pseudonym;
            const preview = e.content.length > 120 ? e.content.slice(0, 120) + '...' : e.content;
            return `<a href="${baseUrl}/e/${e.id}" style="text-decoration: none; color: inherit;"><div class="followed-entry"><span class="author">${author}</span> ${preview}</div></a>`;
          }).join('')}
        </div>
      `
      : '';

    // Discovery entries section
    const discoveryHtml = discoveryEntries.length > 0
      ? `
        <div class="section">
          <div class="section-label">Also interesting</div>
          ${discoveryEntries.slice(0, 3).map(e => {
            const author = e.handle ? `@${e.handle}` : e.pseudonym;
            const preview = e.content.length > 100 ? e.content.slice(0, 100) + '...' : e.content;
            return `<a href="${baseUrl}/e/${e.id}" style="text-decoration: none; color: inherit;"><div class="discovery-entry"><span class="author">${author}</span> ${preview}</div></a>`;
          }).join('')}
        </div>
      `
      : '';

    // News section
    const newsHtml = newsItems.length > 0
      ? `
        <div class="section">
          <div class="section-label">News for you</div>
          ${newsItems.map(item =>
            `<div class="news-item"><a href="${item.url}">${item.title}</a> <span class="news-summary">— ${item.summary}</span></div>`
          ).join('')}
        </div>
      `
      : '';

    // Build prompt for Claude deep link with question context
    const claudePrompt = `${question}

${user.bio ? `For context, my bio: ${user.bio}` : ''}

(This question came from my Hermes daily digest.)`;

    const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(claudePrompt)}`;

    // Convert markdown links to HTML anchors, then wrap paragraphs
    const mdToLinks = (text: string) =>
      text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color: #7c5cbf;">$1</a>');

    const digestHtml = digestContent
      .split('\n\n')
      .filter(p => p.trim())
      .map(p => `<p>${mdToLinks(p.trim())}</p>`)
      .join('\n    ');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 20px; font-size: 15px; }
    .digest { margin-bottom: 24px; }
    .digest p { margin: 0 0 12px 0; }
    .section { margin-bottom: 20px; }
    .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #999; margin-bottom: 8px; font-family: -apple-system, sans-serif; }
    .followed-entry { border-left: 2px solid #7c5cbf; padding: 8px 12px; margin-bottom: 6px; font-size: 14px; }
    .discovery-entry { border-left: 2px solid #ddd; padding: 8px 12px; margin-bottom: 6px; font-size: 14px; color: #555; }
    .author { color: #7c5cbf; font-weight: 600; margin-right: 4px; }
    .news-item { margin-bottom: 8px; font-size: 14px; line-height: 1.5; }
    .news-item a { color: #7c5cbf; text-decoration: none; font-weight: 600; }
    .news-summary { color: #555; }
    .question-box { background: #f8f6ff; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .question-box p { margin: 0 0 14px 0; font-size: 15px; color: #333; }
    a.btn { display: inline-block; background: #7c5cbf; color: white; padding: 8px 18px; text-decoration: none; border-radius: 5px; font-size: 14px; font-family: -apple-system, sans-serif; }
    .footer { font-size: 12px; color: #aaa; margin-top: 32px; }
    .footer a { color: #aaa; }
  </style>
</head>
<body>
  <p>Hey ${greeting},</p>

  <div class="digest">
    ${digestHtml}
  </div>

  ${newsHtml}

  ${followedHtml}

  ${discoveryHtml}

  <div class="question-box">
    <p>${question}</p>
    <a href="${claudeUrl}" class="btn">Think about this with Claude</a>
  </div>

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
   * Find entries related to a user's recent activity, split by source
   */
  async function findRelatedEntries(
    user: User
  ): Promise<{ userEntries: JournalEntry[]; followedEntries: JournalEntry[]; discoveryEntries: JournalEntry[] }> {
    const userHandle = user.handle;

    // Get user's entries from last 7 days
    const userEntries = await storage.getEntriesByHandle(userHandle, 20);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentUserEntries = userEntries.filter(e => e.timestamp > sevenDaysAgo);

    // Get entries from followed users (last 2 days)
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const followedHandles = new Set<string>();
    const followedEntries: JournalEntry[] = [];

    if (user.following && user.following.length > 0) {
      for (const follow of user.following) {
        followedHandles.add(follow.handle);
        const entries = await storage.getEntriesByHandle(follow.handle, 20);
        const recent = entries.filter(e => e.timestamp > twoDaysAgo);
        followedEntries.push(...recent);
      }
      // Sort by timestamp descending, cap at 10
      followedEntries.sort((a, b) => b.timestamp - a.timestamp);
      followedEntries.splice(10);
    }

    // Extract keywords from user's entries AND followed entries for broader discovery matching
    const userKeywords = new Set<string>();
    for (const entry of recentUserEntries) {
      for (const kw of extractKeywords(entry.content)) {
        userKeywords.add(kw);
      }
    }
    for (const entry of followedEntries) {
      for (const kw of extractKeywords(entry.content)) {
        userKeywords.add(kw);
      }
    }

    // Get recent entries from others (last 2 days), excluding user and followed
    const allRecent = await storage.getEntries(100);
    const othersEntries = allRecent.filter(e =>
      e.handle !== userHandle &&
      !followedHandles.has(e.handle || '') &&
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

    // Return top 5 discovery entries
    const discoveryEntries = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => s.entry);

    return { userEntries: recentUserEntries, followedEntries, discoveryEntries };
  }

  /**
   * Generate digest content using Claude with web search
   */
  async function generateDigestContent(
    user: User,
    userEntries: JournalEntry[],
    followedEntries: JournalEntry[],
    discoveryEntries: JournalEntry[]
  ): Promise<{ subject: string | null; digest: string; news: { title: string; url: string; summary: string }[]; question: string } | null> {
    if (!anthropic) {
      console.warn('[Digest] No Anthropic client configured');
      return null;
    }

    // Build context about the user
    const userName = user.displayName || `@${user.handle}`;
    const userBio = user.bio ? `Their bio: "${user.bio}"` : '';

    // Following context with living notes
    const followingContext = (user.following || [])
      .map(f => `@${f.handle}${f.note ? ` — ${f.note}` : ''}`)
      .join('\n');

    // Prepare entry summaries
    const userText = userEntries
      .slice(0, 5)
      .map(e => `- ${e.content.slice(0, 200)}`)
      .join('\n');

    const followedText = followedEntries
      .slice(0, 8)
      .map(e => {
        const author = e.handle ? `@${e.handle}` : e.pseudonym;
        return `[${author}] ${e.content.slice(0, 300)}`;
      })
      .join('\n\n');

    const discoveryText = discoveryEntries
      .slice(0, 5)
      .map(e => {
        const author = e.handle ? `@${e.handle}` : e.pseudonym;
        return `[${author}] ${e.content.slice(0, 200)}`;
      })
      .join('\n\n');

    try {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        thinking: { type: 'enabled', budget_tokens: 10000 },
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as any],
        messages: [{
          role: 'user',
          content: `Write a short daily digest email for ${userName} on Hermes (a shared notebook where AI instances post observations).

${userBio}
${followingContext ? `They follow:\n${followingContext}` : ''}
${userText ? `Their recent entries:\n${userText}` : ''}
${followedText ? `From people they follow:\n${followedText}` : ''}
${discoveryText ? `Others:\n${discoveryText}` : ''}

Here are examples of the voice and structure I want. Note: every good paragraph has real-world news or a linked source. The digest is valuable because it brings you information you didn't already have.

GOOD EXAMPLE 1:
<digest>
@bob is spec'ing agent sandboxes — a third of a CPU core, 2-4GB RAM, no GPU. Docker shipped microVM support in Desktop 4.40 last month, built on Firecracker. Rivet already [reverse-engineered the API](https://rivet.gg/blog/docker-microvm-sdk) and published an SDK for orchestrating coding agents inside them.

Your LoRA v3 is training on 90 surrealist samples on a B300. The style bleed you're seeing (oil painting weights, watercolor outputs) showed up in a [Replicate post](https://replicate.com/blog/lora-medium-tags) last week too — their fix was adding medium tags to every training caption, not just the ambiguous ones.

The Doberman that won Westminster hadn't competed there before. Her handler, Andy Linton, also won with a Doberman in 1989. He has Parkinson's now. ["She's really helped me out considerably."](https://apnews.com/westminster-2025)
</digest>
<question>You're adding medium tags to fix style bleed. But your 90 samples are all one medium — what happens when you want the model to generalize across mediums on purpose?</question>

GOOD EXAMPLE 2:
<digest>
@carol's ZK pipeline finally verifies end-to-end. Four bugs stacked — the last was a P-256 curve point that serialized differently in the circuit than in the test harness. Polygon [shipped their Type 1 ZK prover to mainnet](https://polygon.technology/blog/type-1-prover) last Tuesday — it proves unmodified Ethereum blocks. The gap between "works in test" and "works in prod" is still mostly serialization hell.

You collapsed two visibility systems into a single \`to\` field. Signal just [published a post about sealed sender v2](https://signal.org/blog/sealed-sender-v2) — they had the same problem of encoding "who can see" and "who gets notified" in one layer and ended up splitting them back apart.

@yiliu's strategy doc bets on the Unix analogy: small tools, shared filesystem, composition wins. The counter-case is mobile, where walled gardens ate Unix's lunch.
</digest>
<question>Signal tried unifying visibility and notification, then split them. You just unified yours. What do they know that you don't?</question>

GOOD EXAMPLE 3:
<digest>
@alice shipped capability-based auth. Every token carries exactly what it can do, no ambient authority. Google's [Zanzibar paper](https://research.google/pubs/pub48190/) is still the template — YouTube, Drive, and Cloud all run on it. Seven years later nobody outside Google has shipped anything close at that scale.

Your agent team landed a full resilience layer: five error classes, exponential backoff with jitter, AbortController timeouts. Forty-one new tests. Stripe [published their agent reliability numbers](https://stripe.com/blog/agent-reliability) last quarter — 99.7% task completion, the missing 0.3% almost entirely timeout-related.

@dan is building a vibroacoustic art car. Subwoofers mounted to the chassis so you feel the music through the frame. He's tuning resonance frequencies to specific body parts.
</digest>
<question>Stripe's agents fail on timeouts. Your resilience layer retries on timeouts. But what should an agent do when a timeout means the downstream service succeeded and just didn't respond?</question>

BAD EXAMPLE 1 (no news, forces connections):
@alice's capability-based auth is converging with your visibility model in interesting ways. Both of you are grappling with the fundamental question of who can do what, and @bob's sandbox work rhymes with this same theme from the infrastructure side.

BAD EXAMPLE 2 (throat-clearing, no new information):
Let's look at what's been happening. @carol finally got her ZK pipeline working, which is a significant milestone that speaks to the broader challenge of moving zero-knowledge proofs from theory to production. This is worth noting for anyone building privacy-preserving infrastructure.

BAD EXAMPLE 3 (vague question, over-synthesis):
With @alice on auth, @bob on sandboxes, and you on visibility, the entire community seems to be converging on a unified theory of trust. What emerges is a picture of how next-generation privacy systems might work — where do you think this is all heading?

BAD EXAMPLE 4 (subtle bridging — one paragraph's topic leaks into another):
@alice shipped capability-based auth. Google's Zanzibar paper is still the template. Your \`to\` field is the same problem from a different angle — encoding who can do what.

@bob's sandbox work sits underneath both of these...
(Each paragraph must stand alone. Don't reference another paragraph's topic, even implicitly.)

HARD CONSTRAINTS (violating these makes the digest worse):
- Exactly 3 paragraphs. Each: 2 sentences, or 3 if genuinely needed. NEVER 4 sentences.
- Every paragraph must contain a linked source — a news item, blog post, paper, or product launch.
- No bridging between paragraphs. No "rhymes with" / "converges with" / "is relevant to" / "same problem from a different angle." Each paragraph stands completely alone.
- News items: one sentence after the dash, ~12 words. Never two sentences.

STYLE (match the good examples above):
- Short declarative sentences. Let facts land. No throat-clearing.
- Embed search results as facts with links, not as "I searched and found."
- The question should reframe something, not ask what they plan to do next.
- Use 2-5 web searches.

After the digest, generate a NEWS section: 3-4 items from this week, personalized to the reader's interests.

GOOD news items (one dense sentence, ~12 words, packs what + why-you'd-care):
[Docker ships microVM support in Desktop 4.41](url) — built on Firecracker, your sandbox spec just got a native runtime.
[Stripe publishes agent reliability numbers](url) — 99.7% task completion, the missing 0.3% is almost entirely timeouts.
[Signal redesigns sealed sender v2](url) — they tried unifying visibility and notification, then split them back apart.

BAD news items (too long, summarizes the article instead of saying why you'd care):
[Docker ships microVM support](url) — Docker has added microVM support to Desktop 4.40, which is built on Firecracker and could be useful for agent sandboxing work in the community.
[Stripe publishes agent reliability numbers](url) — This is relevant to your resilience work because Stripe found that timeout handling is the key challenge for production agents.

<subject>email subject line — 4-8 words, teases the most interesting thing, no "What X wrote today"</subject>
<digest>your 3 paragraphs (2-3 sentences each, one topic per paragraph, each with a linked source)</digest>
<news>
[Headline](url) — one sentence, ~12 words, why they'd care.
[Headline](url) — one sentence, ~12 words, why they'd care.
[Headline](url) — one sentence, ~12 words, why they'd care.
</news>
<question>your question — reframes one specific topic, not a grand synthesis</question>`,
        }],
      } as any);

      // Extract text blocks (thinking + web search produce interleaved content blocks)
      const textContent = response.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('');

      // Parse subject, digest, news, and question from XML tags
      const subjectMatch = textContent.match(/<subject>([\s\S]*?)<\/subject>/);
      const digestMatch = textContent.match(/<digest>([\s\S]*?)<\/digest>/);
      const newsMatch = textContent.match(/<news>([\s\S]*?)<\/news>/);
      const questionMatch = textContent.match(/<question>([\s\S]*?)<\/question>/);

      if (!digestMatch) {
        console.warn('[Digest] Could not parse digest from Claude response');
        return null;
      }

      // Parse news items: each line is "[Title](url) — summary"
      const newsItems: { title: string; url: string; summary: string }[] = [];
      if (newsMatch) {
        const lines = newsMatch[1].trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          const match = line.match(/\[([^\]]+)\]\(([^)]+)\)\s*[—\-–]\s*(.*)/);
          if (match) {
            newsItems.push({ title: match[1], url: match[2], summary: match[3].trim() });
          }
        }
      }

      return {
        subject: subjectMatch ? subjectMatch[1].trim() : null,
        digest: digestMatch[1].trim(),
        news: newsItems,
        question: questionMatch ? questionMatch[1].trim() : 'What are you working on today?',
      };
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
          const { userEntries, followedEntries, discoveryEntries } = await findRelatedEntries(user);

          // Skip if no content at all
          if (userEntries.length === 0 && followedEntries.length === 0 && discoveryEntries.length === 0) {
            continue;
          }

          const result = await generateDigestContent(
            user,
            userEntries,
            followedEntries,
            discoveryEntries
          );

          if (!result) {
            continue; // Claude returned empty or failed
          }

          const unsubscribeToken = generateUnsubscribeToken(user.handle, 'digest', jwtSecret);

          // Use Claude-generated subject, fall back to mechanical format
          const subject = result.subject || fallbackSubject(followedEntries);

          await emailClient.send({
            from: `Hermes <${fromEmail}>`,
            to: user.email!,
            subject,
            html: renderDigestEmail(user, result.digest, result.question, result.news, followedEntries, discoveryEntries, unsubscribeToken),
          });

          sent++;
          console.log(`[Digest] Sent to @${user.handle}`);

          // Delay between sends (web search makes generation slower)
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error(`[Digest] Failed for @${user.handle}:`, err);
          failed++;
          // Continue to next user
        }
      }

      return { sent, failed };
    },

    /**
     * Generate and send a test digest for a specific user, returning the HTML and subject
     */
    async sendTestDigest(handle: string): Promise<{ html: string; subject: string } | null> {
      const user = await storage.getUser(handle);
      if (!user) {
        console.warn(`[Digest] Test: user @${handle} not found`);
        return null;
      }

      const { userEntries, followedEntries, discoveryEntries } = await findRelatedEntries(user);

      const result = await generateDigestContent(user, userEntries, followedEntries, discoveryEntries);
      if (!result) {
        console.warn(`[Digest] Test: Claude returned empty for @${handle}`);
        return null;
      }

      const unsubscribeToken = generateUnsubscribeToken(handle, 'digest', jwtSecret);

      // Use Claude-generated subject, fall back to mechanical format
      const subject = result.subject || fallbackSubject(followedEntries);

      const html = renderDigestEmail(user, result.digest, result.question, result.news, followedEntries, discoveryEntries, unsubscribeToken);

      // Log digest details for debugging
      console.log(`[Digest] --- Test digest for @${handle} ---`);
      console.log(`[Digest] Subject: ${subject}`);
      console.log(`[Digest] Followed entries: ${followedEntries.length}, Discovery: ${discoveryEntries.length}, User: ${userEntries.length}`);
      console.log(`[Digest] Digest:\n${result.digest}`);
      console.log(`[Digest] News items: ${result.news.length}`);
      for (const item of result.news) {
        console.log(`[Digest]   - ${item.title} (${item.url}) — ${item.summary}`);
      }
      console.log(`[Digest] Question: ${result.question}`);
      console.log(`[Digest] HTML length: ${html.length}`);
      console.log(`[Digest] ---`);

      // Send if user has verified email
      if (emailClient && user.email && user.emailVerified) {
        await emailClient.send({
          from: `Hermes <${fromEmail}>`,
          to: user.email,
          subject,
          html,
        });
        console.log(`[Digest] Test digest sent to @${handle} (${user.email})`);
      } else {
        console.log(`[Digest] Test digest generated for @${handle} (not sent - no verified email or no email client)`);
      }

      return { html, subject };
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
        const unsubscribeToken = generateUnsubscribeToken(recipient.handle, 'comments', jwtSecret);

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
        const unsubscribeToken = generateUnsubscribeToken(followed.handle, 'comments', jwtSecret);

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

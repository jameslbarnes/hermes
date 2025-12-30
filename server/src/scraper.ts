/**
 * Conversation Scraper Module
 *
 * Uses Firecrawl to scrape shared conversation links from
 * ChatGPT, Claude, Gemini, and Grok.
 */

import FirecrawlApp from '@mendable/firecrawl-js';

export type Platform = 'chatgpt' | 'claude' | 'gemini' | 'grok';

export interface ScrapedConversation {
  title: string;
  content: string;  // Markdown from Firecrawl
  platform: Platform;
}

// Initialize Firecrawl client (lazy, only when API key is available)
let firecrawl: FirecrawlApp | null = null;

function getFirecrawl(): FirecrawlApp {
  if (!firecrawl) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new Error('FIRECRAWL_API_KEY environment variable is not set');
    }
    firecrawl = new FirecrawlApp({ apiKey });
  }
  return firecrawl;
}

/**
 * Detect platform from URL
 */
export function detectPlatform(url: string): Platform | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();

    // ChatGPT: share.openai.com/* or chatgpt.com/share/*
    if (hostname === 'share.openai.com') return 'chatgpt';
    if (hostname === 'chatgpt.com' && pathname.includes('/share/')) return 'chatgpt';
    if (hostname === 'chat.openai.com' && pathname.includes('/share/')) return 'chatgpt';

    // Claude: claude.ai/share/*
    if (hostname === 'claude.ai' && pathname.includes('/share/')) return 'claude';

    // Gemini: gemini.google.com/share/*
    if (hostname === 'gemini.google.com' && pathname.includes('/share/')) return 'gemini';

    // Grok: x.com/grok/share/*, grok.x.ai/share/*, or grok.com/share/*
    if (hostname === 'x.com' && pathname.includes('/grok/share/')) return 'grok';
    if (hostname === 'grok.x.ai' && pathname.includes('/share/')) return 'grok';
    if (hostname === 'grok.com' && pathname.includes('/share/')) return 'grok';

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate that a URL is a supported share link
 */
export function isValidShareUrl(url: string): boolean {
  return detectPlatform(url) !== null;
}

/**
 * Scrape a conversation from a share URL
 */
export async function scrapeConversation(url: string): Promise<ScrapedConversation> {
  const platform = detectPlatform(url);
  if (!platform) {
    throw new ScrapeError(
      'URL must be a valid share link from ChatGPT, Claude, Gemini, or Grok',
      'unknown',
      url
    );
  }

  const fc = getFirecrawl();

  try {
    const result = await fc.scrape(url, {
      formats: ['markdown'],
      waitFor: 5000, // Wait for JS to render
    } as any) as any;

    // Extract title from metadata (try multiple sources)
    let title = result.metadata?.title
      || result.metadata?.ogTitle
      || result.title
      || '';

    // Clean up title based on platform
    if (platform === 'chatgpt' && title.includes('ChatGPT')) {
      title = title.replace(/\s*[-|]\s*ChatGPT.*$/, '').trim();
    }
    if (platform === 'claude' && title.includes('Claude')) {
      title = title.replace(/\s*[-|]\s*Claude.*$/, '').trim();
    }
    if (platform === 'gemini' && title.includes('Gemini')) {
      title = title.replace(/\s*[-|]\s*Gemini.*$/, '').trim();
    }
    if (platform === 'grok' && title.includes('Grok')) {
      title = title.replace(/\s*[-|]\s*Grok.*$/, '').trim();
    }

    // Try to extract title from first heading in markdown if still empty
    if (!title && result.markdown) {
      const headingMatch = result.markdown.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        title = headingMatch[1].trim();
      }
    }

    // Fallback title
    if (!title) {
      title = 'Untitled Conversation';
    }

    let content = result.markdown || '';
    if (!content) {
      throw new ScrapeError(
        'Failed to fetch conversation. It may be private or the link may have expired.',
        platform,
        url
      );
    }

    // Remove images from markdown
    content = content
      .replace(/!\[.*?\]\(.*?\)/g, '') // ![alt](url)
      .replace(/\[\!\[.*?\]\(.*?\)\]\(.*?\)/g, '') // [![alt](img)](link)
      .replace(/\n{3,}/g, '\n\n') // Clean up excessive newlines
      .trim();

    return {
      title,
      content,
      platform,
    };
  } catch (error) {
    if (error instanceof ScrapeError) {
      throw error;
    }
    throw new ScrapeError(
      'Failed to fetch conversation. It may be private or the link may have expired.',
      platform,
      url,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Custom error class for scraping failures
 */
export class ScrapeError extends Error {
  constructor(
    message: string,
    public platform: string,
    public url: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}

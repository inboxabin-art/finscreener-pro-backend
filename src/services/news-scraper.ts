/**
 * News Scraper Service
 * Fetches news from free sources: Yahoo Finance, Finnhub (free tier), Alpha Vantage
 */

import { config } from '../config.js';
import { createNews, getStocks } from './supabase.js';

interface NewsItem {
  symbol: string;
  title: string;
  link: string;
  publishedAt: string;
  source: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
  score?: number;
}

interface NewsSource {
  name: string;
  fetchNews: (symbol: string) => Promise<NewsItem[]>;
}

/**
 * Score news impact (0-10)
 * Tier 1: Multi-day potential (score >= 7)
 * Tier 2: Same-day potential (score 4-6)
 * Low: Promotional/noise (score < 4)
 */
export function scoreNewsImpact(item: NewsItem): {
  score: number;
  tier: 'tier1' | 'tier2' | 'low';
  reason: string;
} {
  let score = 5; // Base score
  const title = item.title.toLowerCase();
  const reason: string[] = [];

  // POSITIVE FACTORS (+)
  const positiveKeywords = [
    'beat', 'beats', 'exceeded', 'surpass', 'record', 'growth', 'soar',
    'surge', 'jump', 'rally', 'gain', 'rise', 'upgraded', 'upgrade',
    'buy', 'outperform', 'strong', 'bullish', 'momentum', 'breakout'
  ];

  const negativeKeywords = [
    'miss', 'missed', 'below', 'cut', 'downgraded', 'downgrade',
    'warn', 'warning', 'loss', 'plunge', 'drop', 'fall', 'decline',
    'weak', 'bearish', 'concern', 'risk', 'lawsuit', 'investigation'
  ];

  const highImpactKeywords = [
    'earnings', 'revenue', 'profit', 'guidance', 'acquisition',
    'merger', 'partnership', 'FDA', 'approval', 'trial', 'launch',
    'contract', 'deal', 'breakthrough', 'upgrade', 'downgrade'
  ];

  const sameDayKeywords = [
    'today', 'pre-market', 'after-hours', 'market open', 'trading now'
  ];

  // Calculate positive score
  for (const keyword of positiveKeywords) {
    if (title.includes(keyword)) {
      score += 1;
      reason.push(`positive: ${keyword}`);
    }
  }

  // Calculate negative score (reduces for positive trades)
  for (const keyword of negativeKeywords) {
    if (title.includes(keyword)) {
      score -= 1.5;
      reason.push(`negative: ${keyword}`);
    }
  }

  // High impact news
  for (const keyword of highImpactKeywords) {
    if (title.includes(keyword)) {
      score += 2;
      reason.push(`high-impact: ${keyword}`);
    }
  }

  // Same-day keywords suggest short-term impact
  for (const keyword of sameDayKeywords) {
    if (title.includes(keyword)) {
      score += 0.5;
      reason.push(`same-day indicator`);
    }
  }

  // Sentiment adjustment
  if (item.sentiment === 'positive') score += 1;
  if (item.sentiment === 'negative') score -= 1;

  // Clamp score
  score = Math.max(0, Math.min(10, score));

  // Determine tier
  let tier: 'tier1' | 'tier2' | 'low';
  if (score >= 7) tier = 'tier1';
  else if (score >= 4) tier = 'tier2';
  else tier = 'low';

  return { score, tier, reason: reason.join(', ') };
}

/**
 * Yahoo Finance RSS News Fetcher
 */
async function fetchYahooFinanceNews(symbol: string): Promise<NewsItem[]> {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${symbol}&region=US&lang=en-US`;

    const response = await fetch(url);
    if (!response.ok) return [];

    const xmlText = await response.text();

    // Parse RSS XML
    const items: NewsItem[] = [];
    const itemMatches = xmlText.match(/<item>([\s\S]*?)<\/item>/g) || [];

    for (const itemXml of itemMatches.slice(0, 10)) {
      const title = extractXMLValue(itemXml, 'title');
      const link = extractXMLValue(itemXml, 'link');
      const pubDate = extractXMLValue(itemXml, 'pubDate');
      const source = extractXMLValue(itemXml, 'source') || 'Yahoo Finance';

      if (title && link) {
        items.push({
          symbol: symbol.toUpperCase(),
          title: decodeHTML(title),
          link,
          publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          source: `Yahoo Finance: ${source}`
        });
      }
    }

    return items;
  } catch (error) {
    console.error(`Yahoo Finance error for ${symbol}:`, error);
    return [];
  }
}

/**
 * Finnhub News Fetcher (Free tier: 60 req/min)
 */
async function fetchFinnhubNews(symbol: string): Promise<NewsItem[]> {
  if (!config.finnhubApiKey) {
    return [];
  }

  try {
    // Get company news for last 24 hours
    const today = new Date();
    const from = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromStr}&to=${toStr}&token=${config.finnhubApiKey}`;

    const response = await fetch(url);
    if (!response.ok) return [];

    const news = await response.json();

    return (news as any[]).slice(0, 10).map((item: any) => ({
      symbol: symbol.toUpperCase(),
      title: item.headline,
      link: item.url,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
      source: `Finnhub: ${item.source}`,
      sentiment: item.sentiment > 0.2 ? 'positive' : item.sentiment < -0.2 ? 'negative' : 'neutral'
    }));
  } catch (error) {
    console.error(`Finnhub error for ${symbol}:`, error);
    return [];
  }
}

/**
 * Alpha Vantage News Fetcher (Free tier: 25 req/day)
 */
async function fetchAlphaVantageNews(symbol: string): Promise<NewsItem[]> {
  if (!config.alphaVantageApiKey) {
    return [];
  }

  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbol}&apikey=${config.alphaVantageApiKey}`;

    const response = await fetch(url);
    if (!response.ok) return [];

    const data: any = await response.json();

    if (data.Note) {
      console.warn('Alpha Vantage rate limit reached');
      return [];
    }

    const feed = data.feed || [];
    return feed.slice(0, 10).map((item: any) => ({
      symbol: symbol.toUpperCase(),
      title: item.title,
      link: item.url,
      publishedAt: item.time_published,
      source: `Alpha Vantage: ${item.source}`,
      sentiment: item.sentiment_score > 0.05 ? 'positive' : item.sentiment_score < -0.05 ? 'negative' : 'neutral'
    }));
  } catch (error) {
    console.error(`Alpha Vantage error for ${symbol}:`, error);
    return [];
  }
}

/**
 * Extract value from XML tag
 */
function extractXMLValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : '';
}

/**
 * Decode HTML entities
 */
function decodeHTML(html: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'"
  };
  return html.replace(/&[^;]+;/g, match => entities[match] || match);
}

/**
 * Fetch news for all tracked stocks
 */
export async function fetchNewsForAllStocks(): Promise<Map<string, NewsItem[]>> {
  const stocks = await getStocks();
  const newsMap = new Map<string, NewsItem[]>();

  for (const stock of stocks) {
    const symbol = stock.symbol;
    const allNews: NewsItem[] = [];

    // Fetch from all sources
    const [yahooNews, finnhubNews, avNews] = await Promise.allSettled([
      fetchYahooFinanceNews(symbol),
      fetchFinnhubNews(symbol),
      fetchAlphaVantageNews(symbol)
    ]);

    if (yahooNews.status === 'fulfilled') allNews.push(...yahooNews.value);
    if (finnhubNews.status === 'fulfilled') allNews.push(...finnhubNews.value);
    if (avNews.status === 'fulfilled') allNews.push(...avNews.value);

    // Deduplicate by title
    const uniqueNews = deduplicateNews(allNews);

    // Score each news item
    const scoredNews = uniqueNews.map(item => ({
      ...item,
      ...scoreNewsImpact(item)
    }));

    newsMap.set(symbol, scoredNews);

    // Save to database
    for (const news of scoredNews) {
      try {
        await createNews({
          stockId: stock.id,
          symbol: news.symbol,
          title: news.title,
          link: news.link,
          publishedAt: news.publishedAt,
          source: news.source,
          sentiment: news.sentiment,
          impactScore: news.score,
          impactTier: news.tier
        });
      } catch (error) {
        // Ignore duplicates
      }
    }

    // Rate limit delay
    await sleep(1000);
  }

  return newsMap;
}

/**
 * Fetch news for a single symbol
 */
export async function fetchNewsForSymbol(symbol: string): Promise<NewsItem[]> {
  const allNews: NewsItem[] = [];

  const [yahooNews, finnhubNews, avNews] = await Promise.allSettled([
    fetchYahooFinanceNews(symbol),
    fetchFinnhubNews(symbol),
    fetchAlphaVantageNews(symbol)
  ]);

  if (yahooNews.status === 'fulfilled') allNews.push(...yahooNews.value);
  if (finnhubNews.status === 'fulfilled') allNews.push(...finnhubNews.value);
  if (avNews.status === 'fulfilled') allNews.push(...avNews.value);

  const uniqueNews = deduplicateNews(allNews);

  return uniqueNews.map(item => ({
    ...item,
    ...scoreNewsImpact(item)
  }));
}

/**
 * Deduplicate news by title
 */
function deduplicateNews(news: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return news.filter(item => {
    const key = item.title.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get news sentiment summary for a stock
 */
export function getNewsSummary(news: NewsItem[]): {
  total: number;
  tier1: number;
  tier2: number;
  low: number;
  positive: number;
  negative: number;
  neutral: number;
  avgScore: number;
} {
  const scored = news.map(n => ({ ...n, ...scoreNewsImpact(n) }));

  return {
    total: scored.length,
    tier1: scored.filter(n => n.tier === 'tier1').length,
    tier2: scored.filter(n => n.tier === 'tier2').length,
    low: scored.filter(n => n.tier === 'low').length,
    positive: scored.filter(n => n.sentiment === 'positive').length,
    negative: scored.filter(n => n.sentiment === 'negative').length,
    neutral: scored.filter(n => n.sentiment === 'neutral').length,
    avgScore: scored.length > 0
      ? scored.reduce((sum, n) => sum + n.score, 0) / scored.length
      : 0
  };
}

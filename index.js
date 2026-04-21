/**
 * FinScreener Pro Backend - Complete API Server (CommonJS)
 * All features: Finviz, News Scoring, Alerts, S&P500, Capital Allocation, Screenshot Upload
 */

const http = require('http');
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== SUPABASE CLIENT ====================
const supabaseUrl = process.env.SUPABASE_URL || 'https://owxklgfpjctqribmqtdr.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93eGtsZ2ZwamN0cXJpYm1xZGRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDYzMzgxMTV9.kFgtvO2JQJ5b7R5v7z1C6Q4xKYbBqjN1eF4i1gR3m0s';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ==================== API KEYS ====================
const FINVIZ_API_KEY = process.env.FINVIZ_API_KEY || 'aee3eced-f1e8-4f3a-bd20-feabc58c111a';
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'iO7G4s0BzGHxip4_W8Bou00ml0F1SRFP';
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || POLYGON_API_KEY; // Massive uses same key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyA2amEKGivLhRFm_FxsYfveNNGNoEJ3FN4';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8665955381:AAH692a74tFQ44lQgxyaaHb1A7MeISTmYlI';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5286113328';

// Finviz Elite API base URLs
const FINVIZ_EXPORT_URL = 'https://elite.finviz.com/export.ashx';
const FINVIZ_NEWS_URL = 'https://elite.finviz.com/news_export.ashx';
// User's saved screener preset filters
const FINVIZ_SCREENER_FILTERS = 'cap_smallover,fa_curratio_o1.5,fa_epsyoy1_o20,news_date_prevhours24,sh_relvol_o1.5,ta_sma20_pa';
const FINVIZ_SCREENER_OPTIONS = 'ft=3&o=-change'; // sort by change desc, type=stocks

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'FinScreener Pro Backend',
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// ==================== DATABASE HELPER FUNCTIONS ====================
async function saveOrUpdateStock(stock) {
  const { data: existing } = await supabase
    .from('stocks')
    .select('id')
    .eq('symbol', stock.symbol)
    .single();

  if (existing) {
    await supabase
      .from('stocks')
      .update({
        price: stock.price,
        change: stock.change,
        change_percent: stock.changePercent,
        volume: stock.volume,
        market_cap: stock.marketCap,
        pe_ratio: stock.peRatio,
        eps: stock.eps,
        week_high_52: stock.weekHigh52,
        week_low_52: stock.weekLow52,
        sector: stock.sector,
        industry: stock.industry,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return existing.id;
  } else {
    const { data, error } = await supabase.from('stocks').insert({
      symbol: stock.symbol,
      company_name: stock.companyName || stock.symbol,
      sector: stock.sector || 'Unknown',
      industry: stock.industry || 'Unknown',
      price: stock.price,
      change: stock.change,
      change_percent: stock.changePercent,
      volume: stock.volume,
      market_cap: stock.marketCap,
      pe_ratio: stock.peRatio,
      eps: stock.eps,
      week_high_52: stock.weekHigh52,
      week_low_52: stock.weekLow52,
      relative_volume: stock.relativeVolume,
      avg_volume: stock.avgVolume,
      price_dollar: stock.priceDollar,
      screened_date: new Date().toISOString().split('T')[0],
      source: stock.source || 'finviz_api',
      is_active: true,
    }).select().single();

    if (error) {
      console.error('Error saving stock:', error);
      return null;
    }
    return data?.id;
  }
}

// ==================== FINVIZ API INTEGRATION ====================

// Parse CSV text (handles quoted fields with commas)
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    if (vals.length >= headers.length) {
      const row = {};
      headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
      rows.push(row);
    }
  }
  return rows;
}

function parseNum(val) {
  if (!val || val === 'N/A' || val === '-') return null;
  const s = String(val).replace(/[$,%]/g, '').trim();
  if (s.endsWith('B')) return parseFloat(s) * 1e9;
  if (s.endsWith('M')) return parseFloat(s) * 1e6;
  if (s.endsWith('K')) return parseFloat(s) * 1e3;
  return parseFloat(s) || null;
}

// Finviz Elite CSV Export Screener (uses elite.finviz.com/export.ashx)
app.post('/api/screen-stocks', async (req, res) => {
  try {
    console.log('Starting Finviz Elite CSV screener...');

    // Use user's saved preset filters; caller can override filters
    const filters = req.body.filters || FINVIZ_SCREENER_FILTERS;
    const extraOpts = req.body.options || FINVIZ_SCREENER_OPTIONS;

    const exportUrl = `${FINVIZ_EXPORT_URL}?v=111&f=${filters}&${extraOpts}&auth=${FINVIZ_API_KEY}`;
    console.log('Finviz export URL:', exportUrl.replace(FINVIZ_API_KEY, '***'));

    const response = await axios.get(exportUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000
    });

    const rows = parseCSV(response.data);
    console.log(`Finviz returned ${rows.length} stocks`);

    const stocks = rows.map(r => ({
      symbol: (r['ticker'] || r['no.'] || '').trim(),
      companyName: r['company'] || r['company_name'] || r['name'] || '',
      sector: r['sector'] || '',
      industry: r['industry'] || '',
      country: r['country'] || '',
      price: parseNum(r['price']),
      change: parseNum(r['change']),
      changePercent: parseNum(r['change']), // Finviz change col is already %
      volume: parseNum(r['volume']),
      avgVolume: parseNum(r['avg_volume'] || r['avg_vol_3m'] || r['average_volume']),
      marketCap: parseNum(r['market_cap'] || r['mktcap']),
      peRatio: parseNum(r['p/e'] || r['pe']),
      eps: parseNum(r['eps_(ttm)'] || r['eps']),
      weekHigh52: parseNum(r['52w_high'] || r['52_week_high']),
      weekLow52: parseNum(r['52w_low'] || r['52_week_low']),
      relativeVolume: parseNum(r['rel_volume'] || r['relative_volume']),
      currentRatio: parseNum(r['current_ratio'] || r['curr_r']),
      epsGrowthNextYear: parseNum(r['eps_next_y'] || r['eps_growth_next_year']),
      source: 'finviz_elite_csv',
    })).filter(s => s.symbol && s.symbol.length <= 6 && !/^\d/.test(s.symbol));

    // Save to DB
    let savedCount = 0;
    for (const stock of stocks) {
      const id = await saveOrUpdateStock(stock);
      if (id) savedCount++;
    }

    // Fetch Finviz news for each screened stock
    fetchFinvizNewsForStocks(stocks).catch(e => console.error('News fetch error:', e.message));

    res.json({ success: true, found: stocks.length, saved: savedCount, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Screen stocks error:', error.message);
    res.status(500).json({ error: 'Failed to screen stocks', details: error.message });
  }
});

// ==================== NEWS SCRAPING & SCORING ====================

// Fetch news from Finviz Elite news export for a list of stocks
async function fetchFinvizNewsForStocks(stocks) {
  if (!stocks || !stocks.length) return;
  const symbols = stocks.slice(0, 30).map(s => s.symbol);

  for (const symbol of symbols) {
    try {
      // Finviz ticker-specific news export: v=3 with t=TICKER
      const url = `${FINVIZ_NEWS_URL}?v=3&t=${symbol}&auth=${FINVIZ_API_KEY}`;
      const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });

      if (!response.data || response.data.length < 10) continue;

      const rows = parseCSV(response.data);
      for (const row of rows.slice(0, 8)) { // max 8 articles per stock
        const title = row['title'] || row['headline'] || row['news'] || '';
        const newsUrl = row['url'] || row['link'] || '';
        const source = row['source'] || row['publisher'] || 'finviz';
        const dateStr = row['date'] || row['datetime'] || row['time'] || '';

        if (!title) continue;

        // Get or create stock record
        const { data: stockRec } = await supabase.from('stocks').select('id').eq('symbol', symbol).single();
        if (!stockRec) continue;

        // Deduplicate by URL or title+symbol
        const { data: existing } = await supabase.from('news').select('id')
          .eq('stock_id', stockRec.id).eq('title', title).maybeSingle();
        if (existing) continue;

        // Score with Gemini (async, non-blocking)
        const scoring = await scoreNewsWithGemini(title, symbol);

        await supabase.from('news').insert({
          stock_id: stockRec.id,
          title,
          content: '',
          source,
          url: newsUrl,
          published_at: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
          sentiment_score: scoring.sentiment,
          impact_score: scoring.impact,
          impact_tier: scoring.tier,
          impact_reason: scoring.reason,
          scored_at: new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 300)); // avoid rate limiting
    } catch (err) {
      console.log(`[News] Skipped ${symbol}: ${err.message}`);
    }
  }
}

// ==================== GEMINI AI SENTIMENT SCORING ====================

// Score news using Gemini Flash for proper NLP sentiment analysis
async function scoreNewsWithGemini(title, ticker = '') {
  // Fallback scoring in case Gemini fails
  const fallback = fallbackKeywordScore(title);

  if (!GEMINI_API_KEY) return fallback;

  try {
    const prompt = `You are a stock trading news sentiment analyzer. Analyze this news headline for ticker ${ticker}.

Headline: "${title}"

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "sentiment": <float -1.0 to 1.0, negative=bearish, positive=bullish>,
  "impact": <integer 0-100, trading significance>,
  "tier": <"tier1"|"tier2"|"low">,
  "reason": <one sentence explanation max 100 chars>
}

Tiers:
- tier1: Multi-day price mover (M&A, FDA, earnings beat/miss, major contract, analyst upgrade/downgrade)
- tier2: Same-day intraday mover (product launch, exec change, expansion, partnership)
- low: General news, promotional, minor update`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
      { contents: [{ parts: [{ text: prompt }] }] },
      {
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_API_KEY },
        timeout: 10000
      }
    );

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment) || 0)),
      impact: Math.max(0, Math.min(100, Number(parsed.impact) || 0)),
      tier: ['tier1', 'tier2', 'low'].includes(parsed.tier) ? parsed.tier : fallback.tier,
      reason: String(parsed.reason || fallback.reason).slice(0, 200),
    };
  } catch (err) {
    console.warn('[Gemini] Score failed, using fallback:', err.message);
    return fallback;
  }
}

// Fallback keyword scoring (used when Gemini is unavailable)
function fallbackKeywordScore(title) {
  const text = title.toLowerCase();
  const tier1 = ['acquisition','merger','buyout','takeover','fda approval','clinical trial','phase 3','bankruptcy','restructuring','settlement','earnings beat','revenue beat','guidance raise','guidance cut','upgrade','downgrade','target price'];
  const tier2 = ['earnings','revenue','profit','loss','launch','partnership','collaboration','executive','ceo','appointment','resignation','expansion','recall','investigation'];
  const pos = ['surge','jump','rise','gain','soar','rally','growth','beat','strong','bullish','record'];
  const neg = ['drop','fall','plunge','tumble','loss','miss','weak','bearish','cut','layoff','probe','fraud'];

  let s = 0, t1 = 0, t2 = 0;
  tier1.forEach(k => { if (text.includes(k)) { t1++; s += 2; } });
  tier2.forEach(k => { if (text.includes(k)) { t2++; s += 1; } });
  pos.forEach(w => { if (text.includes(w)) s += 1; });
  neg.forEach(w => { if (text.includes(w)) s -= 1; });

  const tier = t1 >= 1 ? 'tier1' : (t2 >= 1 || Math.abs(s) >= 2) ? 'tier2' : 'low';
  return {
    sentiment: Math.max(-1, Math.min(1, s / 5)),
    impact: Math.min(100, t1 * 30 + t2 * 15 + Math.abs(s) * 8),
    tier,
    reason: tier === 'tier1' ? 'High-impact event detected' : tier === 'tier2' ? 'Medium-impact event' : 'Low impact news',
  };
}

// Get news for a stock
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;

    const { data: stock } = await supabase
      .from('stocks')
      .select('id')
      .eq('symbol', symbol)
      .single();

    if (!stock) {
      return res.json({ news: [] });
    }

    const { data: news } = await supabase
      .from('news')
      .select('*')
      .eq('stock_id', stock.id)
      .order('published_at', { ascending: false })
      .limit(20);

    res.json({ news: news || [] });
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Manual news submission
app.post('/api/news/manual', async (req, res) => {
  try {
    const { symbol, title, content, source, url } = req.body;

    if (!symbol || !title) {
      return res.status(400).json({ error: 'Symbol and title are required' });
    }

    const stockId = await saveOrUpdateStock({ symbol, companyName: symbol });
    const scoring = await scoreNewsWithGemini(title + ' ' + (content || ''), symbol);

    const { data, error } = await supabase.from('news').insert({
      stock_id: stockId,
      title,
      content: content || '',
      source: source || 'manual',
      url: url || '',
      published_at: new Date().toISOString(),
      sentiment_score: scoring.sentiment,
      impact_score: scoring.impact,
      impact_tier: scoring.tier,
      impact_reason: scoring.reason,
      scored_at: new Date().toISOString(),
    }).select();

    if (error) throw error;

    res.json({
      success: true,
      news: data,
      scoring
    });
  } catch (error) {
    console.error('Error saving manual news:', error);
    res.status(500).json({ error: 'Failed to save news' });
  }
});

// ==================== PRICE DATA ====================

// Fetch and store price data
app.post('/api/prices/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const days = req.body.days || 30;

    // Get stock ID
    const { data: stock } = await supabase
      .from('stocks')
      .select('id')
      .eq('symbol', symbol)
      .single();

    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    // Fetch from Polygon
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const response = await axios.get(
      `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${formatDate(startDate)}/${formatDate(endDate)}?adjusted=true&apiKey=${POLYGON_API_KEY}`,
      { timeout: 15000 }
    );

    if (response.data?.results) {
      for (const bar of response.data.results) {
        await supabase.from('stock_prices').upsert({
          stock_id: stock.id,
          date: new Date(bar.t).toISOString().split('T')[0],
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        }, {
          onConflict: 'stock_id,date'
        });
      }
    }

    res.json({
      success: true,
      symbol,
      barsLoaded: response.data?.results?.length || 0
    });
  } catch (error) {
    console.error('Error fetching prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Get price history
app.get('/api/prices/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const days = parseInt(req.query.days) || 30;

    const { data: stock } = await supabase
      .from('stocks')
      .select('id')
      .eq('symbol', symbol)
      .single();

    if (!stock) {
      return res.json({ prices: [] });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data: prices } = await supabase
      .from('stock_prices')
      .select('*')
      .eq('stock_id', stock.id)
      .gte('date', startDate.toISOString().split('T')[0])
      .order('date', { ascending: true });

    res.json({ prices: prices || [] });
  } catch (error) {
    console.error('Error fetching prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// ==================== ALERT GENERATION ====================

// Generate alerts for all stocks
app.post('/api/generate-alerts', async (req, res) => {
  try {
    console.log('Generating alerts for all stocks...');

    const { data: stocks } = await supabase
      .from('stocks')
      .select('*')
      .eq('is_active', true);

    let alertsGenerated = 0;

    for (const stock of stocks || []) {
      const alerts = await generateAlertsForStock(stock);
      alertsGenerated += alerts.length;
    }

    res.json({
      success: true,
      alertsGenerated,
      stocksProcessed: stocks?.length || 0
    });
  } catch (error) {
    console.error('Error generating alerts:', error);
    res.status(500).json({ error: 'Failed to generate alerts' });
  }
});

// Generate alerts for specific stock
async function generateAlertsForStock(stock) {
  if (!stock.price || stock.price <= 0) return [];

  const alerts = [];

  // Get price history
  const { data: prices } = await supabase
    .from('stock_prices')
    .select('*')
    .eq('stock_id', stock.id)
    .order('date', { ascending: false })
    .limit(30);

  if (!prices || prices.length < 5) return [];

  // Calculate ATR (Average True Range)
  const atr = calculateATR(prices);
  const atrPercent = (atr / stock.price) * 100;

  // VWAP Pullback Strategy
  const vwapAlerts = detectVWAPPullback(stock, prices, atr);
  alerts.push(...vwapAlerts);

  // Double Bottom Pattern
  const doubleBottomAlerts = detectDoubleBottom(stock, prices, atr);
  alerts.push(...doubleBottomAlerts);

  // Breakout Detection
  const breakoutAlerts = detectBreakout(stock, prices, atr);
  alerts.push(...breakoutAlerts);

  // Support/Resistance Zones
  const srAlerts = detectSupportResistance(stock, prices, atr);
  alerts.push(...srAlerts);

  // Get S&P 500 correlation
  const spCorrelation = await getSP500Correlation(stock.symbol);

  // Save alerts
  for (const alert of alerts) {
    await saveAlert(stock.id, {
      ...alert,
      spCorrelation,
      spPrediction: spCorrelation > 0.3 ? 'up' : spCorrelation < -0.3 ? 'down' : 'neutral'
    });
  }

  return alerts;
}

function calculateATR(prices) {
  if (prices.length < 14) return prices[0]?.close * 0.02 || 0;

  let trSum = 0;
  for (let i = 0; i < Math.min(14, prices.length - 1); i++) {
    const high = prices[i].high || prices[i].close;
    const low = prices[i].low || prices[i].close;
    const prevClose = prices[i + 1].close || prices[i + 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trSum += tr;
  }

  return trSum / Math.min(14, prices.length - 1);
}

function detectVWAPPullback(stock, prices, atr) {
  const alerts = [];
  if (prices.length < 3) return alerts;

  const currentPrice = stock.price;
  const currentHigh = prices[0]?.high || currentPrice;
  const currentLow = prices[0]?.low || currentPrice;

  // Simulate VWAP (in production, use real intraday data)
  const vwap = prices.slice(0, 5).reduce((sum, p) => sum + (p.close || 0), 0) / Math.min(5, prices.length);

  // Check if price is near VWAP and pulled back
  const nearVWAP = Math.abs(currentPrice - vwap) / vwap < 0.02;
  const fromAbove = prices[1]?.close > prices[1]?.high * 0.99; // Was near high previously

  if (nearVWAP && fromAbove && currentPrice < vwap) {
    alerts.push({
      strategy_type: 'vwap_pullback',
      alert_price: currentPrice,
      zone_type: 'buy',
      stop_loss: currentPrice - (atr * 1.5),
      target_1: currentPrice + (atr * 2),
      target_2: currentPrice + (atr * 3),
      position_size: calculatePositionSize(currentPrice, currentPrice - atr * 1.5),
      risk_amount: atr * 1.5,
      notes: `VWAP pullback detected. Price pulled back to VWAP from high. ATR: ${atr.toFixed(2)}`
    });
  }

  return alerts;
}

function detectDoubleBottom(stock, prices, atr) {
  const alerts = [];
  if (prices.length < 10) return alerts;

  // Find local lows
  const lows = [];
  for (let i =1; i < prices.length - 1; i++) {
    const low = prices[i].low || prices[i].close;
    const prevLow = prices[i-1]?.low || prices[i-1]?.close || Infinity;
    const nextLow = prices[i+1]?.low || prices[i+1]?.close || Infinity;

    if (low <= prevLow && low <= nextLow) {
      lows.push({ price: low, index: i });
    }
  }

  // Check for double bottom pattern (two similar lows within 3 days)
  for (let i = 0; i < lows.length - 1; i++) {
    const diff = Math.abs(lows[i].price - lows[i+1].price);
    const avgPrice = (lows[i].price + lows[i+1].price) / 2;
    const tolerance = avgPrice * 0.02; // 2% tolerance

    if (diff <= tolerance && lows[i+1].index - lows[i].index <= 3) {
      // Calculate breakout level
      const midPoint = (lows[i].index + lows[i+1].index) / 2;
      const highs = prices.slice(Math.floor(midPoint), lows[i].index + 1);
      const breakoutLevel = Math.max(...highs.map(h => h.high || h.close)) * 1.001;

      alerts.push({
        strategy_type: 'double_bottom',
        alert_price: breakoutLevel,
        zone_type: 'buy',
        stop_loss: avgPrice * 0.98,
        target_1: breakoutLevel + (breakoutLevel - avgPrice) * 1.5,
        target_2: breakoutLevel + (breakoutLevel - avgPrice) * 2.5,
        position_size: calculatePositionSize(breakoutLevel, avgPrice * 0.98),
        risk_amount: breakoutLevel - avgPrice * 0.98,
        notes: `Double bottom pattern detected at ${avgPrice.toFixed(2)}. Breakout level: ${breakoutLevel.toFixed(2)}`
      });
      break; // Only one double bottom per stock
    }
  }

  return alerts;
}

function detectBreakout(stock, prices, atr) {
  const alerts = [];
  if (prices.length < 10) return alerts;

  const currentPrice = stock.price;
  const recentHighs = prices.slice(0, 10).map(p => p.high || p.close);
  const resistance = Math.max(...recentHighs);

  // Calculate average volume
  const avgVolume = prices.slice(0, 5).reduce((sum, p) => sum + (p.volume || 0), 0) / 5;
  const currentVolume = prices[0]?.volume || 0;

  // Check for breakout with volume confirmation
  if (currentPrice > resistance && currentVolume > avgVolume * 1.5) {
    alerts.push({
      strategy_type: 'breakout',
      alert_price: currentPrice,
      zone_type: 'buy',
      stop_loss: resistance * 0.98,
      target_1: currentPrice + (currentPrice - resistance) * 1.5,
      target_2: currentPrice + (currentPrice - resistance) * 2.5,
      position_size: calculatePositionSize(currentPrice, resistance * 0.98),
      risk_amount: currentPrice - resistance * 0.98,
      notes: `Breakout above resistance ${resistance.toFixed(2)} with ${(currentVolume/avgVolume).toFixed(1)}x volume`
    });
  }

  return alerts;
}

function detectSupportResistance(stock, prices, atr) {
  const alerts = [];
  if (prices.length < 15) return alerts;

  // Find levels where price bounced multiple times
  const levelMap = new Map();
  const tolerance = 0.01; // 1% tolerance

  for (let i = 1; i < prices.length - 1; i++) {
    const price = prices[i].close || 0;
    const roundedPrice = Math.round(price / (price * tolerance)) * (price * tolerance);

    // Check if this is a local high or low
    if (prices[i].close > (prices[i-1]?.close || 0) && prices[i].close > (prices[i+1]?.close || 0)) {
      // Resistance
      const existing = levelMap.get(roundedPrice) || { type: 'resistance', touches: 0 };
      existing.touches++;
      existing.price = roundedPrice;
      levelMap.set(roundedPrice, existing);
    } else if (prices[i].close < (prices[i-1]?.close || Infinity) && prices[i].close < (prices[i+1]?.close || Infinity)) {
      // Support
      const existing = levelMap.get(roundedPrice) || { type: 'support', touches: 0 };
      existing.touches++;
      existing.price = roundedPrice;
      levelMap.set(roundedPrice, existing);
    }
  }

  // Generate alerts for strong levels (3+ touches)
  for (const [price, level] of levelMap.entries()) {
    if (level.touches >= 3) {
      const isSupport = level.type === 'support';
      const stopPrice = isSupport ? price * 0.97 : price * 1.03;

      alerts.push({
        strategy_type: 'support_resistance',
        alert_price: price,
        zone_type: isSupport ? 'buy' : 'sell',
        stop_loss: stopPrice,
        target_1: isSupport ? price * 1.05 : price * 0.95,
        target_2: isSupport ? price * 1.08 : price * 0.92,
        position_size: calculatePositionSize(price, stopPrice),
        risk_amount: Math.abs(stock.price - stopPrice),
        notes: `${isSupport ? 'Support' : 'Resistance'} level at ${price.toFixed(2)} with ${level.touches} touches`
      });
    }
  }

  return alerts.slice(0, 2); // Limit to 2 SR alerts per stock
}

function calculatePositionSize(entryPrice, stopLoss) {
  const riskPercent = 0.02; // 2% risk per trade
  const capital = 10000; // Default capital
  const riskAmount = capital * riskPercent;
  const priceRisk = Math.abs(entryPrice - stopLoss);
  return priceRisk > 0 ? Math.floor(riskAmount / priceRisk) : 0;
}

async function getSP500Correlation(symbol) {
  // Simplified correlation - in production, use historical price correlation
  try {
    const { data: stockPrices } = await supabase
      .from('stock_prices')
      .select('close')
      .eq('stock_id', (await supabase.from('stocks').select('id').eq('symbol', symbol).single()).data?.id)
      .order('date', { ascending: false })
      .limit(20);

    // Simulate S&P 500 data
    const sp500Moves = stockPrices?.map((_, i) => (Math.random() - 0.5) * 2) || [];
    const stockMoves = stockPrices?.map((_, i) => (Math.random() - 0.5) * 2) || [];

    if (sp500Moves.length < 5) return 0;

    // Simple correlation calculation
    const avgSP = sp500Moves.reduce((a, b) => a + b, 0) / sp500Moves.length;
    const avgStock = stockMoves.reduce((a, b) => a + b, 0) / stockMoves.length;

    let covariance = 0;
    let spVar = 0;
    let stockVar = 0;

    for (let i = 0; i < sp500Moves.length; i++) {
      covariance += (sp500Moves[i] - avgSP) * (stockMoves[i] - avgStock);
      spVar += Math.pow(sp500Moves[i] - avgSP, 2);
      stockVar += Math.pow(stockMoves[i] - avgStock, 2);
    }

    const correlation = covariance / (Math.sqrt(spVar) * Math.sqrt(stockVar) + 0.0001);
    return Math.max(-1, Math.min(1, correlation));
  } catch (error) {
    return 0;
  }
}

async function saveAlert(stockId, alert) {
  // Check for duplicate
  const { data: existing } = await supabase
    .from('alerts')
    .select('id')
    .eq('stock_id', stockId)
    .eq('strategy_type', alert.strategy_type)
    .eq('status', 'active')
    .single();

  if (existing) {
    // Update existing
    await supabase
      .from('alerts')
      .update({
        alert_price: alert.alert_price,
        zone_type: alert.zone_type,
        stop_loss: alert.stop_loss,
        target_1: alert.target_1,
        target_2: alert.target_2,
        position_size: alert.position_size,
        risk_amount: alert.risk_amount,
        sp_correlation: alert.spCorrelation,
        sp_prediction: alert.spPrediction,
        notes: alert.notes,
      })
      .eq('id', existing.id);
  } else {
    // Create new
    await supabase.from('alerts').insert({
      stock_id: stockId,
      ...alert,
      status: 'active',
      generated_at: new Date().toISOString(),
    });
  }
}

// ==================== S&P 500 PREDICTION ====================

// Get S&P 500 data and predict direction
app.get('/api/sp500/predict', async (req, res) => {
  try {
    // Get recent S&P 500 data from Polygon
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const response = await axios.get(
      `https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${formatDate(startDate)}/${formatDate(endDate)}?adjusted=true&apiKey=${POLYGON_API_KEY}`,
      { timeout: 15000 }
    );

    const bars = response.data?.results || [];

    // Calculate trend
    const recentBars = bars.slice(-10);
    const earlierBars = bars.slice(-20, -10);

    const recentAvg = recentBars.reduce((sum, b) => sum + b.c, 0) / recentBars.length;
    const earlierAvg = earlierBars.reduce((sum, b) => sum + b.c, 0) / earlierBars.length;

    const trend = (recentAvg - earlierAvg) / earlierAvg;

    // Calculate momentum
    const momentum = recentBars.slice(-5).reduce((sum, b, i, arr) => {
      if (i === 0) return 0;
      return sum + (b.c - arr[i-1].c) / arr[i-1].c;
    }, 0);

    // Predict
    let prediction = 'neutral';
    let confidence = 0.5;

    if (trend > 0.01 && momentum > 0.02) {
      prediction = 'up';
      confidence = Math.min(0.95, 0.5 + Math.abs(trend) * 10 + Math.abs(momentum) * 5);
    } else if (trend < -0.01 && momentum < -0.02) {
      prediction = 'down';
      confidence = Math.min(0.95, 0.5 + Math.abs(trend) * 10 + Math.abs(momentum) * 5);
    }

    // Save prediction
    const { data } = await supabase.from('sp500_predictions').insert({
      prediction_time: new Date().toISOString(),
      predicted_direction: prediction,
      confidence: confidence,
      price_change: trend * 100,
    }).select();

    res.json({
      prediction,
      confidence,
      trend: trend * 100,
      momentum: momentum * 100,
      recentPrice: recentBars[recentBars.length - 1]?.c,
      predictionData: data
    });
  } catch (error) {
    console.error('S&P 500 prediction error:', error);
    res.status(500).json({ error: 'Failed to predict S&P 500 direction' });
  }
});

// ==================== CAPITAL ALLOCATION ====================

// Calculate trade parameters
app.post('/api/calculate-trade', async (req, res) => {
  try {
    const { symbol, entryPrice, strategy, capital = 10000, riskPercent = 2 } = req.body;

    if (!symbol || !entryPrice) {
      return res.status(400).json({ error: 'Symbol and entry price are required' });
    }

    // Get ATR for the stock
    const { data: stock } = await supabase
      .from('stocks')
      .select('id')
      .eq('symbol', symbol)
      .single();

    let atr = entryPrice * 0.02; // Default 2% if no data

    if (stock) {
      const { data: prices } = await supabase
        .from('stock_prices')
        .select('high, low, close')
        .eq('stock_id', stock.id)
        .order('date', { ascending: false })
        .limit(14);

      if (prices && prices.length >= 14) {
        atr = calculateATRFromPrices(prices);
      }
    }

    // Strategy-specific parameters
    let stopLoss, target1, target2, positionSize;

    switch (strategy) {
      case 'vwap_pullback':
        stopLoss = entryPrice - (atr * 1.5);
        target1 = entryPrice + (atr * 2);
        target2 = entryPrice + (atr * 3);
        break;
      case 'double_bottom':
        stopLoss = entryPrice - (atr * 2);
        target1 = entryPrice + (atr * 3);
        target2 = entryPrice + (atr * 5);
        break;
      case 'breakout':
        stopLoss = entryPrice - (atr * 1.2);
        target1 = entryPrice + (atr * 2);
        target2 = entryPrice + (atr * 3.5);
        break;
      default:
        stopLoss = entryPrice - atr;
        target1 = entryPrice + atr * 1.5;
        target2 = entryPrice + atr * 2.5;
    }

    // Calculate position size based on risk
    const riskAmount = capital * (riskPercent / 100);
    const priceRisk = Math.abs(entryPrice - stopLoss);
    positionSize = priceRisk > 0 ? Math.floor(riskAmount / priceRisk) : 0;

    // Calculate zones
    const zones = calculateZones(entryPrice, stopLoss, target1, target2, atr);

    res.json({
      symbol,
      entryPrice,
      stopLoss: stopLoss.toFixed(2),
      target1: target1.toFixed(2),
      target2: target2.toFixed(2),
      atr: atr.toFixed(2),
      atrPercent: ((atr / entryPrice) * 100).toFixed(2),
      positionSize,
      riskAmount: riskAmount.toFixed(2),
      riskPercent,
      capital,
      riskReward1: ((target1 - entryPrice) / (entryPrice - stopLoss)).toFixed(2),
      riskReward2: ((target2 - entryPrice) / (entryPrice - stopLoss)).toFixed(2),
      zones
    });
  } catch (error) {
    console.error('Trade calculation error:', error);
    res.status(500).json({ error: 'Failed to calculate trade parameters' });
  }
});

function calculateATRFromPrices(prices) {
  let trSum = 0;
  for (let i = 0; i < Math.min(14, prices.length - 1); i++) {
    const high = prices[i].high || prices[i].close;
    const low = prices[i].low || prices[i].close;
    const prevClose = prices[i + 1].close || prices[i + 1].close;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }

  return trSum / Math.min(14, prices.length - 1);
}

function calculateZones(entryPrice, stopLoss, target1, target2, atr) {
  return [
    { price: target2, label: 'Target 2', type: 'sell', strength: 5 },
    { price: target1, label: 'Target 1', type: 'sell', strength: 4 },
    { price: entryPrice + atr * 0.5, label: 'Early Resistance', type: 'sell', strength: 2 },
    { price: entryPrice, label: 'Entry', type: 'entry', strength: 5 },
    { price: entryPrice - atr * 0.5, label: 'Early Support', type: 'buy', strength: 2 },
    { price: stopLoss, label: 'Stop Loss', type: 'stop', strength: 5 },
  ];
}

// ==================== SCREENSHOT UPLOAD WITH OCR ====================

// Upload screenshot and extract stock symbols
app.post('/api/upload-screenshot', async (req, res) => {
  try {
    const { imageBase64, date } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // In production, use a proper OCR service like Google Vision or Tesseract
    // For now, we'll use a simple approach with base64 image

    // Extract symbols using simple pattern matching
    // This is a placeholder - in production, integrate with OCR API

    const extractedData = await extractSymbolsFromImage(imageBase64);

    // Save each extracted symbol as a stock
    let savedCount = 0;
    for (const symbol of extractedData.symbols) {
      const stockId = await saveOrUpdateStock({
        symbol: symbol.toUpperCase(),
        source: 'manual_screenshot',
        price: extractedData.prices?.[symbol] || 0,
        screenedDate: date || new Date().toISOString().split('T')[0]
      });
      if (stockId) savedCount++;
    }

    res.json({
      success: true,
      symbols: extractedData.symbols,
      prices: extractedData.prices,
      saved: savedCount,
      confidence: extractedData.confidence,
      date: date || new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Screenshot upload error:', error);
    res.status(500).json({ error: 'Failed to process screenshot' });
  }
});

async function extractSymbolsFromImage(imageBase64) {
  // Placeholder OCR extraction
  // In production, use:
  // 1. Google Cloud Vision API
  // 2. AWS Textract
  // 3. Tesseract.js (client-side)
  // 4. Other OCR services

  // For demo purposes, return placeholder data
  // The frontend will allow manual correction of extracted symbols

  return {
    symbols: [],
    prices: {},
    confidence: 0,
    message: 'OCR processing requires external API. Please manually enter symbols.'
  };
}

// Manual stock entry from screenshot
app.post('/api/stocks/manual', async (req, res) => {
  try {
    const { stocks, date, source } = req.body;

    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
      return res.status(400).json({ error: 'Stocks array is required' });
    }

    const results = [];
    for (const stockData of stocks) {
      const stock = {
        symbol: stockData.symbol?.toUpperCase(),
        companyName: stockData.companyName || stockData.symbol,
        sector: stockData.sector || 'Unknown',
        industry: stockData.industry || 'Unknown',
        price: stockData.price,
        change: stockData.change,
        volume: stockData.volume,
        source: source || 'manual_entry',
        screenedDate: date || new Date().toISOString().split('T')[0]
      };

      const id = await saveOrUpdateStock(stock);
      results.push({ symbol: stock.symbol, saved: !!id });
    }

    res.json({
      success: true,
      results,
      total: results.length
    });
  } catch (error) {
    console.error('Manual stock entry error:', error);
    res.status(500).json({ error: 'Failed to save stocks' });
  }
});

// ==================== PERFORMANCE TRACKING ====================

// Get strategy performance stats
app.get('/api/performance/strategies', async (req, res) => {
  try {
    const { data: alerts } = await supabase
      .from('alerts')
      .select('*')
      .eq('status', 'closed');

    const strategyStats = {};

    for (const alert of alerts || []) {
      if (!strategyStats[alert.strategy_type]) {
        strategyStats[alert.strategy_type] = {
          total: 0,
          wins: 0,
          losses: 0,
          totalPnl: 0,
          avgHoldTime: 0,
          holdTimes: []
        };
      }

      const stats = strategyStats[alert.strategy_type];
      stats.total++;

      if (alert.exit_price && alert.entry_price) {
        const pnl = alert.exit_price - alert.entry_price;
        const pnlPercent = (pnl / alert.entry_price) * 100;

        stats.totalPnl += pnlPercent;

        if (pnl > 0) {
          stats.wins++;
        } else {
          stats.losses++;
        }

        if (alert.exit_time && alert.entry_time) {
          const holdTime = (new Date(alert.exit_time) - new Date(alert.entry_time)) / (1000 * 60 * 60); // hours
          stats.holdTimes.push(holdTime);
        }
      }
    }

    // Calculate averages
    const results = Object.entries(strategyStats).map(([strategy, stats]) => ({
      strategy,
      totalAlerts: stats.total,
      successfulAlerts: stats.wins,
      failedAlerts: stats.losses,
      winRate: stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : 0,
      avgPnlPercent: stats.total > 0 ? (stats.totalPnl / stats.total).toFixed(2) : 0,
      avgHoldTime: stats.holdTimes.length > 0
        ? (stats.holdTimes.reduce((a, b) => a + b, 0) / stats.holdTimes.length).toFixed(1)
        : 0,
      totalPnL: stats.totalPnl.toFixed(2)
    }));

    res.json({ strategies: results });
  } catch (error) {
    console.error('Performance stats error:', error);
    res.status(500).json({ error: 'Failed to get performance stats' });
  }
});

// ==================== STOCK CRUD OPERATIONS ====================

// Get all stocks
app.get('/api/stocks', async (req, res) => {
  try {
    const { sector, tier, active } = req.query;

    let query = supabase.from('stocks').select('*');

    if (sector) query = query.eq('sector', sector);
    if (active !== undefined) query = query.eq('is_active', active === 'true');

    const { data: stocks, error } = await query.order('volume', { ascending: false }).limit(100);

    if (error) throw error;

    // Add news tier info to each stock
    for (const stock of stocks || []) {
      const { data: topNews } = await supabase
        .from('news')
        .select('impact_tier')
        .eq('stock_id', stock.id)
        .order('impact_score', { ascending: false })
        .limit(1);

      stock.highestTier = topNews?.[0]?.impact_tier || 'none';
    }

    res.json({ stocks: stocks || [] });
  } catch (error) {
    console.error('Error fetching stocks:', error);
    res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

// Get single stock with details
app.get('/api/stocks/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;

    const { data: stock } = await supabase
      .from('stocks')
      .select('*')
      .eq('symbol', symbol)
      .single();

    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    // Get news
    const { data: news } = await supabase
      .from('news')
      .select('*')
      .eq('stock_id', stock.id)
      .order('published_at', { ascending: false })
      .limit(10);

    // Get alerts
    const { data: alerts } = await supabase
      .from('alerts')
      .select('*')
      .eq('stock_id', stock.id)
      .order('generated_at', { ascending: false })
      .limit(10);

    res.json({
      stock,
      news: news || [],
      alerts: alerts || []
    });
  } catch (error) {
    console.error('Error fetching stock:', error);
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

// Get alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const { status, strategy, limit } = req.query;

    let query = supabase.from('alerts').select('*, stocks:symbol');

    if (status) query = query.eq('status', status);
    if (strategy) query = query.eq('strategy_type', strategy);

    const { data: alerts, error } = await query
      .order('generated_at', { ascending: false })
      .limit(parseInt(limit) || 100);

    if (error) throw error;

    // Enrich with stock info
    for (const alert of alerts || []) {
      const { data: stock } = await supabase
        .from('stocks')
        .select('symbol, price, change')
        .eq('id', alert.stock_id)
        .single();

      if (stock) {
        alert.stockSymbol = stock.symbol;
        alert.stockPrice = stock.price;
        alert.stockChange = stock.change;
      }
    }

    res.json({ alerts: alerts || [] });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Update alert status
app.put('/api/alerts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, entryPrice, exitPrice, exitReason } = req.body;

    const updates = { status };

    if (status === 'triggered' && entryPrice) {
      updates.entry_price = entryPrice;
      updates.entry_time = new Date().toISOString();
      updates.triggered_at = new Date().toISOString();
    }

    if (status === 'closed' && exitPrice) {
      updates.exit_price = exitPrice;
      updates.exit_time = new Date().toISOString();

      // Calculate P&L
      const { data: alert } = await supabase
        .from('alerts')
        .select('entry_price')
        .eq('id', id)
        .single();

      if (alert?.entry_price) {
        const pnl = exitPrice - alert.entry_price;
        const pnlPercent = (pnl / alert.entry_price) * 100;
        const holdTime = alert.entry_time
          ? Math.round((new Date().getTime() - new Date(alert.entry_time).getTime()) / (1000 * 60))
          : 0;

        // Create performance record
        await supabase.from('alert_performance').insert({
          alert_id: id,
          entry_price: alert.entry_price,
          exit_price: exitPrice,
          pnl,
          pnl_percent: pnlPercent,
          hold_time: holdTime,
          exited_by: exitReason || 'manual',
        });
      }
    }

    const { data, error } = await supabase
      .from('alerts')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ success: true, alert: data });
  } catch (error) {
    console.error('Error updating alert:', error);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ==================== LIVE PRICE SNAPSHOT ====================

// Fetch live prices using Massive/Polygon v3/snapshot (batch, real-time 1-min data)
async function fetchLivePricesFromMassive(symbols) {
  if (!symbols.length) return {};
  try {
    // v3/snapshot supports batch tickers with ticker.any_of and returns session_price (live)
    const batchSize = 50;
    const results = {};

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize).join(',');
      const response = await axios.get(
        `https://api.massive.com/v3/snapshot?ticker.any_of=${batch}&limit=${batchSize}`,
        {
          headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
          params: { apiKey: MASSIVE_API_KEY },
          timeout: 15000
        }
      );

      for (const t of (response.data?.results || [])) {
        // session_price = current live price; last_minute_close as backup
        const price = t.session?.price || t.last_minute?.close || t.prev_day?.close || 0;
        const prevClose = t.prev_day?.close || price;
        const change = t.session?.change || (price - prevClose);
        const changePercent = t.session?.change_percent || (prevClose > 0 ? (change / prevClose) * 100 : 0);
        results[t.ticker] = {
          price,
          change,
          changePercent,
          volume: t.session?.volume || t.prev_day?.volume || 0,
          vwap: t.session?.vwap || 0,
          high: t.session?.high || 0,
          low: t.session?.low || 0,
        };
      }
    }
    return results;
  } catch (err) {
    // Fallback to v2/snapshot (Polygon-compatible)
    console.warn('[Massive v3] Falling back to v2/snapshot:', err.message);
    return fetchLivePricesV2Fallback(symbols);
  }
}

// Fallback: Polygon-compatible v2/snapshot
async function fetchLivePricesV2Fallback(symbols) {
  if (!symbols.length) return {};
  try {
    const tickers = symbols.join(',');
    const response = await axios.get(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers}&apiKey=${POLYGON_API_KEY}`,
      { timeout: 15000 }
    );
    const results = {};
    for (const t of (response.data?.tickers || [])) {
      const price = t.min?.c || t.prevDay?.c || 0;
      const prevClose = t.prevDay?.c || price;
      const change = price - prevClose;
      const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
      results[t.ticker] = { price, change, changePercent, volume: t.day?.v || t.prevDay?.v || 0, vwap: t.day?.vw || 0, high: t.day?.h || 0, low: t.day?.l || 0 };
    }
    return results;
  } catch (error) {
    console.error('[v2/snapshot fallback] Error:', error.message);
    return {};
  }
}

// GET /api/stocks/live-prices — returns current prices for all active stocks
app.get('/api/stocks/live-prices', async (req, res) => {
  try {
    const { data: stocks } = await supabase
      .from('stocks')
      .select('id, symbol')
      .eq('is_active', true)
      .limit(100);

    if (!stocks?.length) return res.json({ prices: {} });

    const symbols = stocks.map(s => s.symbol);
    const prices = await fetchLivePricesFromMassive(symbols);
    res.json({ prices, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching live prices:', error);
    res.status(500).json({ error: 'Failed to fetch live prices' });
  }
});

// POST /api/stocks/refresh-prices — updates stocks table with live Polygon snapshot prices
app.post('/api/stocks/refresh-prices', async (req, res) => {
  try {
    const { data: stocks } = await supabase
      .from('stocks')
      .select('id, symbol')
      .eq('is_active', true)
      .limit(100);

    if (!stocks?.length) return res.json({ updated: 0 });

    const symbols = stocks.map(s => s.symbol);
    const priceMap = await fetchLivePricesFromMassive(symbols);

    let updated = 0;
    for (const stock of stocks) {
      const p = priceMap[stock.symbol];
      if (!p || !p.price) continue;
      await supabase.from('stocks').update({
        price: p.price,
        change: p.change,
        change_percent: p.changePercent,
        volume: p.volume || undefined,
        updated_at: new Date().toISOString(),
      }).eq('id', stock.id);
      updated++;
    }

    console.log(`✅ [Snapshot] Refreshed prices for ${updated} stocks`);
    res.json({ success: true, updated, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error refreshing prices:', error);
    res.status(500).json({ error: 'Failed to refresh prices' });
  }
});

// ==================== TELEGRAM NOTIFICATIONS ====================

// Send Telegram notification
app.post('/api/telegram/send', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      },
      { timeout: 10000 }
    );

    res.json({ success: true, message_id: response.data?.result?.message_id });
  } catch (error) {
    console.error('Telegram send error:', error);
    res.status(500).json({ error: 'Failed to send Telegram message' });
  }
});

// ==================== CRON JOB ENDPOINTS ====================

// Daily screening at market open
app.post('/api/cron/daily-screen', async (req, res) => {
  try {
    console.log('Running daily screening...');

    // This would be triggered by Railway cron or external scheduler
    const screenResult = await new Promise((resolve) => {
      const mockReq = { body: {} };
      const mockRes = {
        json: (data) => resolve(data),
        status: (code) => ({ json: (err) => resolve({ error: err }) })
      };
      // Call screen-stocks handler
      app._router.handle({ ...mockReq, method: 'POST', path: '/api/screen-stocks', url: '/api/screen-stocks' }, mockRes);
    });

    // Generate alerts
    await generateAlertsForAllStocks();

    // Send summary to Telegram
    await sendDailySummary();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Daily screening completed'
    });
  } catch (error) {
    console.error('Daily screen error:', error);
    res.status(500).json({ error: 'Failed to run daily screen' });
  }
});

async function generateAlertsForAllStocks() {
  const { data: stocks } = await supabase
    .from('stocks')
    .select('*')
    .eq('is_active', true);

  for (const stock of stocks || []) {
    await generateAlertsForStock(stock);
  }
}

async function sendDailySummary() {
  const { count: stockCount } = await supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true });

  const { count: alertCount } = await supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const message = `
📊 <b>FinScreener Pro - Daily Summary</b>

🗓️ Date: ${new Date().toLocaleDateString()}
📈 Total Stocks: ${stockCount || 0}
⚡ Active Alerts: ${alertCount || 0}

Ready for trading day!
`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    console.error('Failed to send daily summary:', error);
  }
}

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// ==================== MANUAL TRIGGER ENDPOINTS ====================

// Manual trigger: Screen stocks from Finviz
app.post('/api/trigger/screen-stocks', async (req, res) => {
  console.log('🔔 [MANUAL] Triggering stock screening...');
  try {
    // Reuse the screen-stocks logic
    const finvizFilters = req.body.filters || {
      dayVolumeOver: 500000,
      priceAbove: 2,
      priceBelow: 100,
      relativeVolumeAbove: 1.2
    };

    const finvizFiltersList = [];
    if (finvizFilters.dayVolumeOver) finvizFiltersList.push(`average_volume[${finvizFilters.dayVolumeOver},]`);
    if (finvizFilters.priceAbove) finvizFiltersList.push(`price[${finvizFilters.priceAbove},]`);
    if (finvizFilters.priceBelow) finvizFiltersList.push(`price[,${finvizFilters.priceBelow}]`);
    if (finvizFilters.relativeVolumeAbove) finvizFiltersList.push(`relative_volume[${finvizFilters.relativeVolumeAbove},]`);
    finvizFiltersList.push('market_cap[small,mid,large]');
    finvizFiltersList.push('exchange[nasdaq,nye]');
    finvizFiltersList.push('sector[Technology,Healthcare,Consumer Cyclical,Industrials,Communication Services]');

    const finvizUrl = `https://finviz.com/screener.ashx?v=152&f=${finvizFiltersList.join(',')}&o=ticker&r=1`;

    // Try to get data from Finviz
    let stocks = [];
    if (process.env.FINVIZ_EMAIL && process.env.FINVIZ_COOKIE) {
      try {
        const response = await axios.get(finvizUrl, {
          headers: {
            'Cookie': process.env.FINVIZ_COOKIE,
            'User-Agent': 'Mozilla/5.0 (compatible; FinScreener/1.0)'
          },
          timeout: 30000
        });
        const $ = cheerio.load(response.data);
        const rows = $('table.screener_table tbody tr');
        rows.each((i, row) => {
          const cols = $(row).find('td');
          if (cols.length >= 10) {
            const symbol = $(cols[1]).text().trim();
            if (symbol && /^[A-Z.]+$/.test(symbol)) {
              stocks.push({
                symbol,
                company: $(cols[2]).text().trim(),
                sector: $(cols[3]).text().trim(),
                industry: $(cols[4]).text().trim(),
                country: $(cols[5]).text().trim(),
                price: parseFloat($(cols[6]).text().replace('$', '')) || 0,
                change: $(cols[7]).text().trim(),
                volume: parseInt($(cols[8]).text().replace(/,/g, '')) || 0,
                marketCap: $(cols[9]).text().trim(),
                pe: $(cols[10]) ? parseFloat($(cols[10]).text()) || null : null
              });
            }
          }
        });
      } catch (e) {
        console.log('Finviz scrape failed:', e.message);
      }
    }

    // Save to database
    let saved = 0;
    for (const stock of stocks) {
      const { error } = await supabase
        .from('stocks')
        .upsert({
          symbol: stock.symbol,
          company_name: stock.company,
          sector: stock.sector,
          industry: stock.industry,
          country: stock.country,
          market_cap: stock.marketCap,
          pe_ratio: stock.pe,
          is_active: true,
          screened_date: new Date().toISOString().split('T')[0]
        }, { onConflict: 'symbol' });

      if (!error) saved++;
    }

    console.log('✅ [MANUAL] Screening completed:', { found: stocks.length, saved });
    res.json({ success: true, found: stocks.length, saved, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ [MANUAL] Screening failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger: Fetch prices for all active stocks
app.post('/api/trigger/fetch-prices', async (req, res) => {
  console.log('🔔 [MANUAL] Triggering price fetch for all stocks...');
  try {
    const { data: stocks } = await supabase
      .from('stocks')
      .select('symbol')
      .eq('is_active', true)
      .limit(100);

    const results = { total: stocks?.length || 0, success: 0, failed: 0, updated: [] };

    for (const stock of stocks || []) {
      try {
        const response = await axios.post(
          `http://localhost:${PORT}/api/prices/${stock.symbol}`,
          { days: 30 },
          { timeout: 15000 }
        );
        if (response.data.success) {
          results.success++;
          results.updated.push(stock.symbol);
        }
      } catch (e) {
        results.failed++;
      }
    }

    console.log('✅ [MANUAL] Price fetch completed:', results);
    res.json({ success: true, ...results, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ [MANUAL] Price fetch failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger: Generate alerts for all stocks
app.post('/api/trigger/generate-alerts', async (req, res) => {
  console.log('🔔 [MANUAL] Triggering alert generation...');
  try {
    const { data: stocks } = await supabase
      .from('stocks')
      .select('symbol, id')
      .eq('is_active', true)
      .limit(50);

    let alertsGenerated = 0;

    for (const stock of stocks || []) {
      try {
        // Get price data
        const { data: prices } = await supabase
          .from('prices')
          .select('*')
          .eq('symbol', stock.symbol)
          .order('date', { ascending: false })
          .limit(30);

        if (!prices || prices.length < 5) continue;

        // Calculate alerts (simplified)
        const currentPrice = prices[0]?.close || 0;
        const high30d = Math.max(...prices.map(p => p.high));
        const low30d = Math.min(...prices.map(p => p.low));
        const avgVolume = prices.reduce((sum, p) => sum + p.volume, 0) / prices.length;
        const currentVolume = prices[0]?.volume || 0;

        // VWAP Alert
        const vwap = prices.reduce((sum, p) => sum + (p.high + p.low + p.close) / 3 * p.volume, 0) /
                     prices.reduce((sum, p) => sum + p.volume, 0);
        if (Math.abs(currentPrice - vwap) / vwap < 0.02 && currentPrice > vwap) {
          await supabase.from('alerts').insert({
            stock_id: stock.id,
            symbol: stock.symbol,
            strategy: 'VWAP Breakout',
            entry_price: currentPrice,
            stop_loss: currentPrice * 0.97,
            target_1: currentPrice * 1.05,
            target_2: currentPrice * 1.10,
            status: 'pending',
            notes: 'VWAP breakout detected'
          });
          alertsGenerated++;
        }

        // Double Bottom Alert
        if (prices.length >= 10) {
          const recentLows = prices.slice(0, 10).map(p => p.low);
          const minLow = Math.min(...recentLows);
          const minCount = recentLows.filter(l => l <= minLow * 1.02).length;
          if (minCount >= 2 && currentPrice > minLow * 1.03) {
            await supabase.from('alerts').insert({
              stock_id: stock.id,
              symbol: stock.symbol,
              strategy: 'Double Bottom',
              entry_price: currentPrice,
              stop_loss: minLow * 0.97,
              target_1: currentPrice + (currentPrice - minLow) * 1.5,
              target_2: currentPrice + (currentPrice - minLow) * 2,
              status: 'pending',
              notes: 'Double bottom pattern detected'
            });
            alertsGenerated++;
          }
        }

        // Breakout Alert
        if (currentPrice > high30d * 0.98 && prices[0]?.volume > avgVolume * 1.5) {
          await supabase.from('alerts').insert({
            stock_id: stock.id,
            symbol: stock.symbol,
            strategy: 'Breakout',
            entry_price: currentPrice,
            stop_loss: high30d * 0.97,
            target_1: high30d * 1.05,
            target_2: high30d * 1.10,
            status: 'pending',
            notes: '30-day breakout with volume confirmation'
          });
          alertsGenerated++;
        }
      } catch (e) {
        console.log('Alert generation failed for', stock.symbol);
      }
    }

    console.log('✅ [MANUAL] Alerts generated:', alertsGenerated);
    res.json({ success: true, alertsGenerated, stocksProcessed: stocks?.length || 0, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ [MANUAL] Alert generation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger: Update S&P500 prediction
app.post('/api/trigger/sp500-prediction', async (req, res) => {
  console.log('🔔 [MANUAL] Triggering S&P500 prediction update...');
  try {
    const response = await axios.get('http://localhost:' + PORT + '/api/sp500/predict', { timeout: 30000 });
    console.log('✅ [MANUAL] S&P500 prediction updated');
    res.json({ success: true, prediction: response.data, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ [MANUAL] S&P500 prediction failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger: Run all data updates (full refresh)
app.post('/api/trigger/full-refresh', async (req, res) => {
  console.log('🔔 [MANUAL] Triggering full data refresh...');
  try {
    // Screen stocks
    const screenResult = await axios.post('http://localhost:' + PORT + '/api/trigger/screen-stocks', {}, { timeout: 120000 });

    // Fetch prices
    const priceResult = await axios.post('http://localhost:' + PORT + '/api/trigger/fetch-prices', {}, { timeout: 300000 });

    // Generate alerts
    const alertResult = await axios.post('http://localhost:' + PORT + '/api/trigger/generate-alerts', {}, { timeout: 120000 });

    // Update S&P500 prediction
    const sp500Result = await axios.post('http://localhost:' + PORT + '/api/trigger/sp500-prediction', {}, { timeout: 30000 });

    console.log('✅ [MANUAL] Full refresh completed');
    res.json({
      success: true,
      screening: screenResult.data,
      prices: priceResult.data,
      alerts: alertResult.data,
      sp500: sp500Result.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ [MANUAL] Full refresh failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CRON SCHEDULER ====================

// Run daily screening at market open (9:30 AM EST) - every weekday
cron.schedule('30 9 * * 1-5', async () => {
  console.log('🔔 [CRON] Running daily stock screening...');
  try {
    // Screen stocks from Finviz
    const response = await axios.post('http://localhost:' + PORT + '/api/screen-stocks', {}, { timeout: 120000 });
    console.log('✅ [CRON] Screening completed:', response.data);

    // Generate alerts
    await axios.post('http://localhost:' + PORT + '/api/generate-alerts', {}, { timeout: 120000 });
    console.log('✅ [CRON] Alerts generated');

    // Get S&P500 prediction
    await axios.get('http://localhost:' + PORT + '/api/sp500/predict', { timeout: 30000 });
    console.log('✅ [CRON] S&P500 prediction updated');

    // Send Telegram summary
    await sendDailySummary();
    console.log('✅ [CRON] Daily summary sent');
  } catch (error) {
    console.error('❌ [CRON] Daily screening failed:', error.message);
  }
}, {
  timezone: 'America/New_York'
});

// Update prices every 15 minutes during market hours (9:30 AM - 4:15 PM EST) - every weekday
// Uses Polygon snapshot for live current prices instead of daily historical bars
cron.schedule('*/15 9-16 * * 1-5', async () => {
  console.log('🔔 [CRON] Refreshing live stock prices via Polygon snapshot...');
  try {
    await axios.post('http://localhost:' + PORT + '/api/stocks/refresh-prices', {}, { timeout: 30000 });
  } catch (error) {
    console.error('❌ [CRON] Live price refresh failed:', error.message);
  }
}, {
  timezone: 'America/New_York'
});

// Update S&P500 prediction every 4 hours
cron.schedule('0 */4 * * *', async () => {
  console.log('🔔 [CRON] Updating S&P500 prediction...');
  try {
    await axios.get('http://localhost:' + PORT + '/api/sp500/predict', { timeout: 30000 });
    console.log('✅ [CRON] S&P500 prediction updated');
  } catch (error) {
    console.error('❌ [CRON] S&P500 prediction failed:', error.message);
  }
});

// Refresh alerts every 30 minutes during market hours
cron.schedule('*/30 9-16 * * 1-5', async () => {
  console.log('🔔 [CRON] Regenerating alerts...');
  try {
    await axios.post('http://localhost:' + PORT + '/api/generate-alerts', {}, { timeout: 120000 });
    console.log('✅ [CRON] Alerts regenerated');
  } catch (error) {
    console.error('❌ [CRON] Alert generation failed:', error.message);
  }
}, {
  timezone: 'America/New_York'
});

console.log('⏰ Cron scheduler initialized');
console.log('   - Daily screening: 9:30 AM EST (weekdays)');
console.log('   - Price updates: Every hour 10AM-4PM EST (weekdays)');
console.log('   - S&P500 prediction: Every 4 hours');
console.log('   - Alert refresh: Every 30 mins during market hours');

// ==================== START SERVER ====================

const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('FinScreener Pro Backend');
  console.log('Time: ' + new Date().toISOString());
  console.log('Port: ' + PORT);
  console.log('==========================================');
  console.log('Available endpoints:');
  console.log('  GET  /health');
  console.log('  POST /api/screen-stocks');
  console.log('  POST /api/generate-alerts');
  console.log('  POST /api/prices/:symbol');
  console.log('  GET  /api/prices/:symbol');
  console.log('  GET  /api/stocks');
  console.log('  GET  /api/stocks/:symbol');
  console.log('  GET  /api/news/:symbol');
  console.log('  POST /api/news/manual');
  console.log('  GET  /api/alerts');
  console.log('  PUT  /api/alerts/:id');
  console.log('  GET  /api/sp500/predict');
  console.log('  POST /api/calculate-trade');
  console.log('  POST /api/upload-screenshot');
  console.log('  POST /api/stocks/manual');
  console.log('  GET  /api/performance/strategies');
  console.log('  POST /api/telegram/send');
  console.log('==========================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;

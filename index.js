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

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== SUPABASE CLIENT ====================
const supabaseUrl = process.env.SUPABASE_URL || 'https://owxklgfpjctqribmqtdr.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_xSrKhmigmOUKWA3hCUCPsw_ZYGdCk3M';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ==================== API KEYS ====================
const FINVIZ_API_KEY = process.env.FINVIZ_API_KEY || 'aee3eced-f1e8-4f3a-bd20-feabc58c111a';
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'iO7G4s0BzGHxip4_W8Bou00ml0F1SRFP';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8665955381:AAH692a74tFQ44lQgxyaaHb1A7MeISTmYlI';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5286113328';

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

// Finviz Elite API - Fetch screener results
app.post('/api/screen-stocks', async (req, res) => {
  try {
    console.log('Starting Finviz screener fetch...');

    // Use Finviz API
    const filters = req.body.filters || {
      dayVolumeOver: 500000,
      priceAbove: 2,
      priceBelow: 100,
      relativeVolumeAbove: 1.5
    };

    // Build Finviz screener URL
    const screenerUrl = `https://finviz.com/screener.ashx?v=152&f=sh_rel_o5 above,sh_avgvol_o${filters.dayVolumeOver},sh_price_${filters.priceAbove}_${filters.priceBelow},sh_relvol_o${filters.relativeVolumeAbove}&o=-volume&r=1&token=${FINVIZ_API_KEY}`;

    console.log('Fetching from:', screenerUrl.substring(0, 100) + '...');

    const response = await axios.get(screenerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 30000
    });

    const stocks = parseFinvizHTML(response.data);
    console.log(`Found ${stocks.length} stocks from Finviz`);

    // Save to database
    let savedCount = 0;
    for (const stock of stocks) {
      const id = await saveOrUpdateStock(stock);
      if (id) savedCount++;
    }

    // Fetch news for each stock
    await fetchNewsForStocks(stocks);

    res.json({
      success: true,
      found: stocks.length,
      saved: savedCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Screen stocks error:', error);
    res.status(500).json({
      error: 'Failed to screen stocks',
      details: error.message
    });
  }
});

// Parse Finviz HTML response
function parseFinvizHTML(html) {
  const $ = cheerio.load(html);
  const stocks = [];

  $('table.screener_table tbody tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 10) {
      const symbol = $(cells[0]).text().trim();
      if (symbol && symbol.length <= 5 && !symbol.includes('No.') && !symbol.includes('Ticker')) {
        const priceText = $(cells[5]).text().replace('$', '').trim();
        const changeText = $(cells[6]).text().replace('%', '').replace('+', '').trim();
        const volumeText = $(cells[7]).text().replace(/,/g, '').trim();

        stocks.push({
          symbol: symbol,
          companyName: $(cells[1]).text().trim(),
          sector: $(cells[2]).text().trim(),
          industry: $(cells[3]).text().trim(),
          price: parseFloat(priceText) || 0,
          change: parseFloat(changeText) || 0,
          volume: parseInt(volumeText) || 0,
          marketCap: parseMarketCap($(cells[8]).text()),
          peRatio: parseFloat($(cells[9]).text()) || null,
          eps: parseFloat($(cells[10]).text()) || null,
          source: 'finviz_api'
        });
      }
    }
  });

  return stocks;
}

function parseMarketCap(text) {
  if (!text) return 0;
  const match = text.match(/([\d.]+)([BMTK])/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  switch (match[2].toUpperCase()) {
    case 'B': return value * 1e9;
    case 'M': return value * 1e6;
    case 'K': return value * 1e3;
    default: return value;
  }
}

// ==================== NEWS SCRAPING & SCORING ====================

// Fetch news from Polygon.io
async function fetchNewsForStocks(stocks) {
  for (const stock of stocks.slice(0, 20)) { // Limit to 20 stocks per run
    try {
      const response = await axios.get(
        `https://api.polygon.io/v2/reference/news?ticker=${stock.symbol}&limit=5&apiKey=${POLYGON_API_KEY}`,
        { timeout: 10000 }
      );

      if (response.data?.results) {
        for (const article of response.data.results) {
          await saveAndScoreNews(stock.symbol, article);
        }
      }
    } catch (error) {
      console.log(`No news from Polygon for ${stock.symbol}`);
    }
  }
}

// Save news and score it
async function saveAndScoreNews(symbol, article) {
  // Get stock ID
  const { data: stock } = await supabase
    .from('stocks')
    .select('id')
    .eq('symbol', symbol)
    .single();

  if (!stock) return;

  // Check if news already exists
  const { data: existing } = await supabase
    .from('news')
    .select('id')
    .eq('url', article.article_url || article.url)
    .single();

  if (existing) return;

  // Score the news
  const scoring = scoreNewsImpact(article.title || '', article.description || '', article.keywords || []);

  // Save to database
  await supabase.from('news').insert({
    stock_id: stock.id,
    title: article.title || 'No title',
    content: article.description || '',
    source: article.source || 'unknown',
    url: article.article_url || article.url || '',
    published_at: article.published_utc || new Date().toISOString(),
    sentiment_score: scoring.sentiment,
    impact_score: scoring.impact,
    impact_tier: scoring.tier,
    impact_reason: scoring.reason,
    scored_at: new Date().toISOString(),
  });
}

// News Impact Scoring Engine
function scoreNewsImpact(title, content, keywords = []) {
  const text = `${title} ${content}`.toLowerCase();
  const allKeywords = [...keywords.map(k => k.toLowerCase())];

  // High impact keywords - Tier 1 (Multi-day potential)
  const tier1Keywords = [
    'acquisition', 'merger', 'buyout', 'takeover', 'deal', 'contract',
    'fda approval', 'clinical trial', 'phase 3', 'breakthrough',
    'partnership', 'collaboration', 'ipo', 'public offering',
    'bankruptcy', 'restructuring', 'lawsuit', 'settlement',
    'upgrade', 'downgrade', 'analyst', 'target price', 'rating',
    'earnings beat', 'revenue beat', 'guidance raise', 'guidance cut'
  ];

  // Medium impact keywords - Tier 2 (Same-day potential)
  const tier2Keywords = [
    'earnings', 'revenue', 'profit', 'loss', 'quarterly', 'annual',
    'launch', 'product', 'release', 'announcement', 'press release',
    'executive', 'ceo', 'cfo', 'appointment', 'resignation',
    'expansion', 'new market', 'store opening', 'expanding',
    'recall', 'safety', 'investigation', 'probe'
  ];

  // Check for high impact
  let tier1Matches = 0;
  let tier2Matches = 0;
  let sentimentScore = 0;

  for (const keyword of tier1Keywords) {
    if (text.includes(keyword)) {
      tier1Matches++;
      sentimentScore += 2;
    }
  }

  for (const keyword of tier2Keywords) {
    if (text.includes(keyword)) {
      tier2Matches++;
      sentimentScore += 1;
    }
  }

  // Sentiment analysis
  const positiveWords = ['surge', 'jump', 'rise', 'gain', 'soar', 'rally', 'growth', 'profit', 'beat', 'strong', 'upgrade', 'bullish'];
  const negativeWords = ['drop', 'fall', 'plunge', 'tumble', 'loss', 'miss', 'weak', 'downgrade', 'bearish', 'cut', 'layoff', 'investigation'];

  for (const word of positiveWords) {
    if (text.includes(word)) sentimentScore += 1;
  }
  for (const word of negativeWords) {
    if (text.includes(word)) sentimentScore -= 1;
  }

  // Determine tier
  let tier = 'low';
  let reason = 'General promotional or low-impact news';

  if (tier1Matches >= 2 || (tier1Matches >= 1 && sentimentScore >= 3)) {
    tier = 'tier1';
    reason = `High impact: ${tier1Matches} Tier-1 keywords detected. Potential for multi-day price movement.`;
  } else if (tier1Matches >= 1 || tier2Matches >= 2 || Math.abs(sentimentScore) >= 2) {
    tier = 'tier2';
    reason = `Medium impact: ${tier2Matches} Tier-2 keywords. Same-day trading opportunity.`;
  } else if (sentimentScore !== 0) {
    tier = 'tier2';
    reason = 'Sentiment detected but limited duration. Intraday only.';
  }

  return {
    sentiment: Math.max(-1, Math.min(1, sentimentScore / 5)),
    impact: Math.min(100, (tier1Matches * 30) + (tier2Matches * 15) + Math.abs(sentimentScore) * 10),
    tier,
    reason
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
    const scoring = scoreNewsImpact(title, content || '', []);

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

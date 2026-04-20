/**
 * FinScreener Pro Backend
 *
 * Real-time stock data, alerts, Telegram notifications, Finviz scraping, News aggregation
 * Designed for Railway deployment
 */

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initSupabase, getStocks, getAlerts, createAlert, updateAlert, getNews, getStocksByDate } from './services/supabase.js';
import { initPolygon, subscribeToStocks, getRealTimeQuote, get1MinBars, getAggBars, getDailyBars } from './services/polygon.js';
import { initTelegram, sendAlert, sendDailySummary, sendSystemStatus } from './services/telegram.js';
import { startAlertMonitor, checkAlerts } from './services/alert-monitor.js';
import { initFinviz, getFinvizService } from './services/finviz.js';
import { fetchNewsForAllStocks, fetchNewsForSymbol, getNewsSummary } from './services/news-scraper.js';
import { startScheduler, getSchedulerStatus } from './services/scheduler.js';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();
const PORT = config.port || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      polygon: config.polygonApiKey ? 'configured' : 'not configured',
      telegram: config.telegramBotToken ? 'configured' : 'not configured',
      supabase: config.supabaseUrl ? 'configured' : 'not configured'
    }
  });
});

// API Routes
app.get('/api/stocks', async (req, res) => {
  try {
    const stocks = await getStocks();
    res.json(stocks);
  } catch (error) {
    console.error('Error fetching stocks:', error);
    res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

app.get('/api/stocks/:symbol/quote', async (req, res) => {
  try {
    const { symbol } = req.params;
    const quote = await getRealTimeQuote(symbol.toUpperCase());
    res.json(quote);
  } catch (error) {
    console.error('Error fetching quote:', error);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

app.get('/api/stocks/:symbol/bars/:multiplier/:timespan', async (req, res) => {
  try {
    const { symbol, multiplier, timespan } = req.params;
    const from = req.query.from as string || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = req.query.to as string || new Date().toISOString();

    const bars = await getAggBars(
      symbol.toUpperCase(),
      parseInt(multiplier),
      timespan as any,
      from,
      to
    );
    res.json(bars);
  } catch (error) {
    console.error('Error fetching bars:', error);
    res.status(500).json({ error: 'Failed to fetch bars' });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await getAlerts();
    res.json(alerts);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

app.post('/api/alerts', async (req, res) => {
  try {
    const alert = await createAlert(req.body);

    // Send Telegram notification for new alert
    if (config.telegramBotToken && config.telegramChatId) {
      await sendAlert({
        symbol: req.body.symbol || 'Unknown',
        type: req.body.strategyType,
        price: req.body.alertPrice,
        stopLoss: req.body.stopLoss,
        target1: req.body.target1,
        confidence: req.body.confidence || 0.7
      });
    }

    res.json(alert);
  } catch (error) {
    console.error('Error creating alert:', error);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

app.patch('/api/alerts/:id', async (req, res) => {
  try {
    const alert = await updateAlert(req.params.id, req.body);

    // Send Telegram notification for triggered/closed alerts
    if (config.telegramBotToken && config.telegramChatId && req.body.status === 'triggered') {
      await sendAlert({
        symbol: alert.stockId || 'Unknown',
        type: 'TRIGGERED',
        price: req.body.entryPrice || alert.alertPrice,
        message: `Alert TRIGGERED at $${req.body.entryPrice}`
      });
    }

    res.json(alert);
  } catch (error) {
    console.error('Error updating alert:', error);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

app.get('/api/news/:stockId', async (req, res) => {
  try {
    const news = await getNews(req.params.stockId);
    res.json(news);
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ===== FINVIZ ROUTES =====

// Fetch stocks from Finviz
app.post('/api/finviz/fetch', async (req, res) => {
  try {
    const finviz = getFinvizService();
    if (!finviz) {
      res.status(500).json({ error: 'Finviz not configured' });
      return;
    }

    const filters = req.body.filters;
    const savedCount = await finviz.fetchAndSaveStocks(filters);

    res.json({
      success: true,
      savedCount,
      message: `Fetched and saved ${savedCount} stocks from Finviz`
    });
  } catch (error) {
    console.error('Error fetching from Finviz:', error);
    res.status(500).json({ error: 'Failed to fetch from Finviz' });
  }
});

// Get available Finviz filters
app.get('/api/finviz/filters', (req, res) => {
  res.json({
    available: {
      sector: ['technology', 'healthcare', 'financial', 'energy', 'consumer', 'industrial', 'materials', 'utilities', 'realestate'],
      marketCap: ['mega_large', 'large', 'mid', 'small', 'micro'],
      valuation: ['overvalued', 'fairvalued', 'undervalued'],
      profitability: ['high_roe', 'low_roe', 'high_roa', 'low_roa'],
      dividend: ['div_positive', 'div_zero', 'div_negative'],
      price: ['price_above_10', 'price_below_20', 'price_50_100', 'etc'],
      technical: ['ta_sma20_pa', 'ta_sma50_pa', 'ta_sma200_pa', 'ta_rsi_ob', 'ta_macd_b']
    },
    examples: {
      techGrowth: 'sec_technology,cap_smallover,fa_curratio_o1.5,fa_epsyoy_o20,news_prevahours24,sh_relvol_o1.5,ta_sma20_pa',
      highVolume: 'sh_relvol_o2,ta_sma20_pa,fa_epsyoy_o10',
      earnings: 'fa_epsqoq_o20,sh_relvol_o1.5'
    }
  });
});

// ===== NEWS ROUTES =====

// Fetch news for all stocks
app.post('/api/news/fetch-all', async (req, res) => {
  try {
    const newsMap = await fetchNewsForAllStocks();

    const summary: any[] = [];
    newsMap.forEach((news, symbol) => {
      summary.push({
        symbol,
        ...getNewsSummary(news)
      });
    });

    res.json({
      success: true,
      totalStocks: newsMap.size,
      summary
    });
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Fetch news for specific symbol
app.get('/api/news/symbol/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const news = await fetchNewsForSymbol(symbol);

    res.json({
      symbol: symbol.toUpperCase(),
      news,
      summary: getNewsSummary(news)
    });
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ===== SCHEDULED JOBS =====

// Get scheduler status
app.get('/api/scheduler/status', (req, res) => {
  res.json(getSchedulerStatus());
});

// Trigger manual fetch (admin endpoint)
app.post('/api/jobs/fetch-stocks', async (req, res) => {
  try {
    const finviz = getFinvizService();
    if (!finviz) {
      res.status(500).json({ error: 'Finviz not configured' });
      return;
    }

    // Fetch stocks
    const savedCount = await finviz.fetchAndSaveStocks(req.body.filters);

    // Fetch news
    const newsMap = await fetchNewsForAllStocks();

    res.json({
      success: true,
      stocksSaved: savedCount,
      newsUpdated: newsMap.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in fetch job:', error);
    res.status(500).json({ error: 'Failed to run fetch job' });
  }
});

// Get stocks for specific date
app.get('/api/stocks/date/:date', async (req, res) => {
  try {
    const stocks = await getStocksByDate(req.params.date);
    res.json(stocks);
  } catch (error) {
    console.error('Error fetching stocks by date:', error);
    res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

// Get today's stocks
app.get('/api/stocks/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const stocks = await getStocksByDate(today);
    res.json({
      date: today,
      count: stocks.length,
      stocks
    });
  } catch (error) {
    console.error('Error fetching today stocks:', error);
    res.status(500).json({ error: 'Failed to fetch today stocks' });
  }
});

// ===== POLYGON REAL-TIME ROUTES =====

// Get daily bars for a symbol
app.get('/api/stocks/:symbol/daily', async (req, res) => {
  try {
    const { symbol } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const bars = await getDailyBars(symbol.toUpperCase(), days);
    res.json({
      symbol: symbol.toUpperCase(),
      days,
      bars
    });
  } catch (error) {
    console.error('Error fetching daily bars:', error);
    res.status(500).json({ error: 'Failed to fetch daily bars' });
  }
});

// Start server
async function start() {
  console.log('Starting FinScreener Pro Backend...');

  // Initialize services
  await initSupabase();

  if (config.polygonApiKey) {
    await initPolygon();
    console.log('✅ Polygon.io connected (Paid tier - real-time enabled)');
  } else {
    console.log('⚠️ Polygon.io not configured - set POLYGON_API_KEY');
  }

  if (config.finvizApiKey) {
    initFinviz();
    console.log('✅ Finviz Elite API connected');
  } else {
    console.log('⚠️ Finviz not configured - set FINVIZ_API_KEY');
  }

  if (config.telegramBotToken && config.telegramChatId) {
    await initTelegram();
    console.log('✅ Telegram connected');

    // Send startup notification
    await sendSystemStatus('started', 'FinScreener Pro Backend is online');
  } else {
    console.log('⚠️ Telegram not configured - set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  }

  // Auto-fetch on startup (if Finviz configured)
  if (config.finvizApiKey) {
    const finviz = getFinvizService();
    if (finviz) {
      console.log('📊 Fetching stocks from Finviz on startup...');
      finviz.fetchAndSaveStocks().then(count => {
        if (count > 0) {
          console.log(`✅ Saved ${count} stocks from Finviz`);
          // Also fetch news
          fetchNewsForAllStocks().then(newsMap => {
            console.log(`✅ Fetched news for ${newsMap.size} stocks`);
          });
        }
      }).catch(err => {
        console.error('Error fetching from Finviz on startup:', err);
      });
    }
  }

  // Start WebSocket server for real-time updates
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const clients = new Set<any>();

  wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    clients.add(ws);

    ws.on('close', () => {
      clients.delete(ws);
    });

    // Send initial data
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  // Broadcast function for real-time updates
  (global as any).broadcast = (data: any) => {
    const message = JSON.stringify(data);
    clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  };

  // Subscribe to stocks for real-time data
  if (config.polygonApiKey) {
    subscribeToStocks();
    console.log('Subscribed to real-time stock data');
  }

  // Start alert monitoring
  startAlertMonitor();
  console.log('Alert monitoring active');

  // Start scheduler (24/7)
  startScheduler();
  console.log('Scheduler running 24/7');

  server.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`\nEnvironment:`);
    console.log(`   Railway: ${config.isRailway ? 'Yes' : 'No'}`);
    console.log(`   Polygon.io: ${config.polygonApiKey ? 'Configured' : 'Not configured'}`);
    console.log(`   Supabase: ${config.supabaseUrl ? 'Configured' : 'Not configured'}`);
    console.log(`   Telegram: ${config.telegramBotToken ? 'Configured' : 'Not configured'}`);
  });
}

start().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  if (config.telegramBotToken) {
    await sendSystemStatus('stopped', 'FinScreener Pro Backend is shutting down');
  }
  process.exit(0);
});

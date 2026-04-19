/**
 * FinScreener Pro Backend
 *
 * Real-time stock data, alerts, and Telegram notifications
 * Designed for Railway deployment
 */

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initSupabase, getStocks, getAlerts, createAlert, updateAlert, getNews } from './services/supabase.js';
import { initPolygon, subscribeToStocks, getRealTimeQuote, get1MinBars, getAggBars } from './services/polygon.js';
import { initTelegram, sendAlert, sendDailySummary, sendSystemStatus } from './services/telegram.js';
import { startAlertMonitor, checkAlerts } from './services/alert-monitor.js';
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

// Start server
async function start() {
  console.log('Starting FinScreener Pro Backend...');

  // Initialize services
  await initSupabase();

  if (config.polygonApiKey) {
    await initPolygon();
    console.log('Polygon.io connected');
  } else {
    console.log('Polygon.io not configured - set POLYGON_API_KEY');
  }

  if (config.telegramBotToken && config.telegramChatId) {
    await initTelegram();
    console.log('Telegram connected');

    // Send startup notification
    await sendSystemStatus('started', 'FinScreener Pro Backend is online');
  } else {
    console.log('Telegram not configured - set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
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

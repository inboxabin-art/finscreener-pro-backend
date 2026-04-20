/**
 * Configuration - Loads from environment variables
 * Supports both local development and Railway deployment
 */

import dotenv from 'dotenv';

// Load .env file for local development
dotenv.config();

export const config = {
  // Server - Railway sets PORT env var, use it or fallback
  port: parseInt(process.env.PORT || '3001'),
  isRailway: !!process.env.RAILWAY_ENVIRONMENT,

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',

  // Polygon.io - Real-time stock data (PAID TIER)
  polygonApiKey: process.env.POLYGON_API_KEY || '',

  // Finviz - Stock screener (Elite API)
  finvizApiKey: process.env.FINVIZ_API_KEY || '',

  // News APIs (free tiers)
  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || '',
  newsApiKey: process.env.NEWS_API_KEY || '',

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Alert settings
  alertSettings: {
    checkIntervalMs: parseInt(process.env.ALERT_CHECK_INTERVAL || '30000'), // 30 seconds
    trailingStopMultiplier: parseFloat(process.env.TRAILING_STOP_MULTIPLIER || '2.0'),
    defaultRiskPercent: parseFloat(process.env.DEFAULT_RISK_PERCENT || '1.0'),
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '10'),
  },

  // Market hours (EST)
  marketHours: {
    open: '09:30',
    close: '16:00',
    timezone: 'America/New_York',
  },

  // Scheduled jobs
  scheduledJobs: {
    finvizFetch: process.env.FINVIZ_FETCH_CRON || '30 14 * * 1-5', // 2:30 PM UK (9:30 AM ET) Mon-Fri
    newsFetch: process.env.NEWS_FETCH_CRON || '0 14 * * 1-5',       // 2:00 PM UK Mon-Fri
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Validate required config
export function validateConfig(): boolean {
  const required: string[] = [];

  if (!config.supabaseUrl) required.push('SUPABASE_URL');
  if (!config.supabaseKey) required.push('SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY');

  if (!config.polygonApiKey) {
    console.warn('⚠️ POLYGON_API_KEY not set - real-time data disabled');
  }
  if (!config.finvizApiKey) {
    console.warn('⚠️ FINVIZ_API_KEY not set - screener fetch disabled');
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn('⚠️ Telegram not configured - notifications disabled');
  }

  if (required.length > 0) {
    console.error(`❌ Missing required environment variables: ${required.join(', ')}`);
    return false;
  }

  return true;
}

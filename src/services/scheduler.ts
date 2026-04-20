/**
 * Scheduler Service
 * Runs periodic jobs for stock fetching and news aggregation
 * Runs 24/7 at the following schedule:
 * - News fetch: Every hour at :00
 * - Stocks fetch: Every hour at :30
 * - Health check: Every 30 minutes
 */

import cron from 'node-cron';
import { config } from '../config.js';
import { getFinvizService } from './finviz.js';
import { fetchNewsForAllStocks } from './news-scraper.js';
import { sendSystemStatus } from './telegram.js';

let newsJob: cron.ScheduledTask | null = null;
let stocksJob: cron.ScheduledTask | null = null;
let healthCheckJob: cron.ScheduledTask | null = null;

/**
 * Get current UK time string
 */
function getUKTime(): string {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
}

/**
 * Fetch stocks from Finviz
 * Runs every hour at :30 (24/7)
 */
async function fetchStocksJob(): Promise<void> {
  console.log(`📊 [${getUKTime()}] Starting stocks fetch from Finviz...`);

  try {
    const finviz = getFinvizService();
    if (!finviz) {
      console.log('⚠️ Finviz not configured - skipping stocks fetch');
      return;
    }

    const count = await finviz.fetchAndSaveStocks();

    if (count > 0) {
      console.log(`✅ Saved ${count} stocks from Finviz`);

      // Also fetch news for new stocks
      await fetchNewsForAllStocks();
      console.log(`✅ News fetched for updated stocks`);
    } else {
      console.log(`📭 No new stocks from Finviz`);
    }
  } catch (error) {
    console.error('❌ Error in stocks fetch job:', error);
  }
}

/**
 * Fetch news for all stocks
 * Runs every hour at :00 (24/7)
 */
async function fetchNewsJob(): Promise<void> {
  console.log(`📰 [${getUKTime()}] Starting news fetch...`);

  try {
    const newsMap = await fetchNewsForAllStocks();
    console.log(`✅ Fetched news for ${newsMap.size} stocks`);
  } catch (error) {
    console.error('❌ Error in news fetch job:', error);
  }
}

/**
 * Health check - runs every 30 minutes
 */
async function healthCheck(): Promise<void> {
  console.log(`💚 [${getUKTime()}] Health check - Scheduler running 24/7`);
}

/**
 * Start all scheduled jobs (24/7)
 */
export function startScheduler(): void {
  console.log('⏰ Starting scheduler (24/7 operation)...');

  // News fetch every hour at :00
  newsJob = cron.schedule('0 * * * *', async () => {
    await fetchNewsJob();
  });

  // Stocks fetch every hour at :30
  stocksJob = cron.schedule('30 * * * *', async () => {
    await fetchStocksJob();
  });

  // Health check every 30 minutes
  healthCheckJob = cron.schedule('*/30 * * * *', async () => {
    await healthCheck();
  });

  console.log('✅ Scheduler started with jobs (24/7):');
  console.log('   📰 News fetch: Every hour at :00 (UK time)');
  console.log('   📊 Stocks fetch: Every hour at :30 (UK time)');
  console.log('   💚 Health check: Every 30 minutes');
}

/**
 * Stop all scheduled jobs
 */
export function stopScheduler(): void {
  if (newsJob) {
    newsJob.stop();
    newsJob = null;
  }
  if (stocksJob) {
    stocksJob.stop();
    stocksJob = null;
  }
  if (healthCheckJob) {
    healthCheckJob.stop();
    healthCheckJob = null;
  }
  console.log('⏰ Scheduler stopped');
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): {
  running: boolean;
  jobs: string[];
  operating24x7: boolean;
  nextNewsFetch: string;
  nextStocksFetch: string;
} {
  const now = new Date();
  const ukTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const minutes = ukTime.getMinutes();

  // Calculate next run times
  const nextNewsMinutes = 60 - minutes;
  const nextStocksMinutes = minutes < 30 ? (30 - minutes) : (90 - minutes);

  return {
    running: newsJob !== null && stocksJob !== null,
    jobs: [
      'News fetch (hourly at :00)',
      'Stocks fetch (hourly at :30)',
      'Health check (every 30 min)'
    ],
    operating24x7: true,
    nextNewsFetch: `${nextNewsMinutes} minutes`,
    nextStocksFetch: `${nextStocksMinutes} minutes`
  };
}

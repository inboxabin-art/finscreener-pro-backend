/**
 * Alert Monitor Service
 * Monitors real-time prices and triggers alerts
 */

import { config } from '../config';
import { getActiveAlerts, triggerAlert, closeAlert, updateAlert } from './supabase';
import { getCachedQuote, get1MinBars, getRealTimeQuote } from './polygon';
import { sendAlert, sendTradeUpdate } from './telegram';
import { checkExitSignal, calculateUTBotStop } from './alert-logic';

let monitorInterval: NodeJS.Timeout | null = null;

// Track state for trailing stops
const alertStates = new Map<string, {
  highSinceEntry: number;
  trailingStop: number;
  utBotStop: number;
}>();

/**
 * Start the alert monitoring service
 */
export function startAlertMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }

  // Check alerts every 30 seconds (configurable)
  monitorInterval = setInterval(
    () => checkAlerts(),
    config.alertSettings.checkIntervalMs
  );

  console.log('🔔 Alert monitor started');
}

/**
 * Stop the alert monitoring service
 */
export function stopAlertMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  console.log('🔔 Alert monitor stopped');
}

/**
 * Check all active alerts against current prices
 */
export async function checkAlerts(): Promise<void> {
  try {
    const activeAlerts = await getActiveAlerts();

    for (const alert of activeAlerts) {
      await checkSingleAlert(alert);
    }
  } catch (error) {
    console.error('Error checking alerts:', error);
  }
}

/**
 * Check a single alert against current price
 */
async function checkSingleAlert(alert: any): Promise<void> {
  const symbol = alert.stock?.symbol || alert.stockId;

  try {
    // Get current price
    const quote = await getRealTimeQuote(symbol);
    if (!quote) return;

    const currentPrice = quote.close;
    const entryPrice = alert.entryPrice || alert.alertPrice;
    const vwap = currentPrice; // Would come from real data

    // Get ATR for this stock (calculated from recent bars)
    const bars = await get1MinBars(
      symbol,
      new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      new Date()
    );

    let atr = 0;
    if (bars.length >= 14) {
      atr = calculateATRFromBars(bars);
    }

    // Initialize state if not exists
    if (!alertStates.has(alert.id)) {
      alertStates.set(alert.id, {
        highSinceEntry: entryPrice,
        trailingStop: entryPrice - (2 * atr),
        utBotStop: entryPrice - (2 * atr),
      });
    }

    const state = alertStates.get(alert.id)!;

    // Update high since entry
    if (currentPrice > state.highSinceEntry) {
      state.highSinceEntry = currentPrice;

      // Calculate new trailing stop
      const keyValue = alert.utBotKeyValue || 2.0;
      state.trailingStop = state.highSinceEntry - (keyValue * atr);
      state.utBotStop = state.trailingStop;
    }

    // Check for alert trigger (price crosses entry level)
    if (alert.status === 'active' && alert.type !== 'triggered') {
      // Price breaks above alert price
      if (currentPrice >= alert.alertPrice) {
        await handleAlertTrigger(alert, currentPrice);
        return;
      }
    }

    // Check for triggered alerts (in trade)
    if (alert.status === 'triggered') {
      const isIntraday = alert.strategyType?.includes('vwap') || alert.strategyType === 'breakout';
      const rsi5min = 55; // Would come from real data
      const sma20 = currentPrice * 0.98; // Would come from real data

      // Check exit signals
      const exitSignal = checkExitSignal(
        currentPrice,
        entryPrice,
        state.highSinceEntry,
        vwap,
        rsi5min,
        sma20,
        state.utBotStop,
        isIntraday
      );

      if (exitSignal.shouldExit) {
        await handleAlertExit(alert, exitSignal.price, exitSignal.reason);
      }
    }

    // Broadcast update to WebSocket clients
    broadcastAlertUpdate(alert.id, {
      currentPrice,
      highSinceEntry: state.highSinceEntry,
      trailingStop: state.trailingStop,
      pnl: ((currentPrice - entryPrice) / entryPrice) * 100,
    });
  } catch (error) {
    console.error(`Error checking alert ${alert.id}:`, error);
  }
}

/**
 * Handle alert trigger (enter trade)
 */
async function handleAlertTrigger(alert: any, price: number): Promise<void> {
  try {
    await triggerAlert(alert.id, price);

    // Send Telegram notification
    await sendAlert({
      symbol: alert.stock?.symbol || 'Unknown',
      type: 'TRIGGERED',
      price,
      stopLoss: alert.stopLoss,
      target1: alert.target1,
      confidence: alert.confidence,
      message: `Alert triggered at $${price.toFixed(2)}`,
    });

    await sendTradeUpdate({
      symbol: alert.stock?.symbol || 'Unknown',
      action: 'ENTRY',
      price,
    });

    // Initialize state
    alertStates.set(alert.id, {
      highSinceEntry: price,
      trailingStop: alert.stopLoss || price * 0.98,
      utBotStop: alert.stopLoss || price * 0.98,
    });

    console.log(`✅ Alert triggered: ${alert.stock?.symbol} @ $${price.toFixed(2)}`);
  } catch (error) {
    console.error('Error triggering alert:', error);
  }
}

/**
 * Handle alert exit
 */
async function handleAlertExit(alert: any, price: number, reason: string): Promise<void> {
  try {
    await closeAlert(alert.id, price, reason);

    // Calculate P&L
    const entryPrice = alert.entryPrice || alert.alertPrice;
    const pnl = price - entryPrice;
    const pnlPercent = ((price - entryPrice) / entryPrice) * 100;

    // Send Telegram notification
    await sendTradeUpdate({
      symbol: alert.stock?.symbol || 'Unknown',
      action: 'EXIT',
      price,
      pnl,
      reason,
    });

    // Clean up state
    alertStates.delete(alert.id);

    const pnlEmoji = pnl >= 0 ? '💚' : '💔';
    console.log(`${pnlEmoji} Alert closed: ${alert.stock?.symbol} @ $${price.toFixed(2)} (${pnlPercent.toFixed(1)}%) - ${reason}`);
  } catch (error) {
    console.error('Error closing alert:', error);
  }
}

/**
 * Calculate ATR from price bars
 */
function calculateATRFromBars(bars: any[]): number {
  if (bars.length < 2) return 0;

  const trueRanges: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trueRanges.push(tr);
  }

  // Use last 14 bars
  const period = 14;
  if (trueRanges.length < period) return 0;

  const recentTRs = trueRanges.slice(-period);
  return recentTRs.reduce((a, b) => a + b, 0) / period;
}

/**
 * Broadcast alert update to WebSocket clients
 */
function broadcastAlertUpdate(alertId: string, update: any) {
  if ((global as any).broadcast) {
    (global as any).broadcast({
      type: 'alert_update',
      alertId,
      ...update,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get monitored alert states
 */
export function getAlertStates(): Map<string, any> {
  return alertStates;
}

/**
 * Polygon.io Service
 * Real-time stock data with 1-minute bars
 */

import { Polygon } from 'polygon-io-client';
import { config } from '../config';

let client: Polygon | null = null;

// Track subscribed symbols
const subscribedSymbols = new Set<string>();
const lastQuotes = new Map<string, any>();
const lastBars = new Map<string, any[]>();

export async function initPolygon(): Promise<void> {
  if (!config.polygonApiKey) {
    throw new Error('Polygon API key not configured');
  }

  client = new Polygon(config.polygonApiKey, 'v2');

  console.log('📊 Polygon.io client initialized');
}

/**
 * Subscribe to real-time quotes for a stock
 */
export async function subscribeToStock(symbol: string): Promise<void> {
  if (!client) {
    throw new Error('Polygon client not initialized');
  }

  const upperSymbol = symbol.toUpperCase();
  subscribedSymbols.add(upperSymbol);

  // Subscribe to quotes
  client.subscribe(`Q.${upperSymbol}`, (data: any) => {
    lastQuotes.set(upperSymbol, {
      symbol: upperSymbol,
      bid: data.bidPrice,
      ask: data.askPrice,
      last: data.lastTradePrice,
      volume: data.volume,
      timestamp: new Date(data.t).toISOString(),
    });

    // Broadcast to WebSocket clients
    broadcastUpdate({
      type: 'quote',
      symbol: upperSymbol,
      data: lastQuotes.get(upperSymbol),
    });
  });
}

/**
 * Subscribe to multiple stocks
 */
export async function subscribeToStocks(): Promise<void> {
  if (!client) {
    console.log('⚠️ Cannot subscribe - Polygon client not initialized');
    return;
  }

  // Subscribe to common market symbols
  const defaultSymbols = ['SPY', 'QQQ', 'IWM'];

  for (const symbol of defaultSymbols) {
    await subscribeToStock(symbol);
  }

  console.log(`📊 Subscribed to ${subscribedSymbols.size} symbols`);
}

/**
 * Get real-time quote for a symbol
 */
export async function getRealTimeQuote(symbol: string): Promise<any> {
  if (!client) {
    throw new Error('Polygon client not initialized');
  }

  try {
    const quote = await client.stocks.previousQuote(symbol.toUpperCase());
    return {
      symbol: symbol.toUpperCase(),
      open: quote.results?.o || 0,
      high: quote.results?.h || 0,
      low: quote.results?.l || 0,
      close: quote.results?.c || 0,
      volume: quote.results?.v || 0,
      timestamp: quote.results?.t ? new Date(quote.results.t).toISOString() : null,
    };
  } catch (error) {
    console.error(`Error fetching quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get 1-minute aggregate bars
 */
export async function get1MinBars(symbol: string, from: Date, to: Date): Promise<any[]> {
  if (!client) {
    throw new Error('Polygon client not initialized');
  }

  try {
    const response = await client.stocks.aggregates(
      symbol.toUpperCase(),
      1,
      'minute',
      from.toISOString(),
      to.toISOString()
    );

    return (response.results || []).map((bar: any) => ({
      timestamp: new Date(bar.t).toISOString(),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  } catch (error) {
    console.error(`Error fetching 1-min bars for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get aggregate bars with custom multiplier
 */
export async function getAggBars(
  symbol: string,
  multiplier: number,
  timespan: 'minute' | 'hour' | 'day' | 'week' | 'month',
  from: string,
  to: string
): Promise<any[]> {
  if (!client) {
    throw new Error('Polygon client not initialized');
  }

  try {
    const response = await client.stocks.aggregates(
      symbol.toUpperCase(),
      multiplier,
      timespan,
      from,
      to
    );

    return (response.results || []).map((bar: any) => ({
      timestamp: new Date(bar.t).toISOString(),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      vwap: bar.vw || null,
    }));
  } catch (error) {
    console.error(`Error fetching bars for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get daily bars for historical analysis
 */
export async function getDailyBars(symbol: string, days: number = 30): Promise<any[]> {
  if (!client) {
    throw new Error('Polygon client not initialized');
  }

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const response = await client.stocks.aggregates(
      symbol.toUpperCase(),
      1,
      'day',
      from.toISOString(),
      to.toISOString()
    );

    return (response.results || []).map((bar: any) => ({
      date: new Date(bar.t).toISOString().split('T')[0],
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  } catch (error) {
    console.error(`Error fetching daily bars for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get last quote from cache
 */
export function getCachedQuote(symbol: string): any {
  return lastQuotes.get(symbol.toUpperCase());
}

/**
 * Get last bars from cache
 */
export function getCachedBars(symbol: string): any[] {
  return lastBars.get(symbol.toUpperCase()) || [];
}

// WebSocket broadcast helper
function broadcastUpdate(data: any) {
  if ((global as any).broadcast) {
    (global as any).broadcast(data);
  }
}

export { subscribedSymbols, lastQuotes, lastBars };

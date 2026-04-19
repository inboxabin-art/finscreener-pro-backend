/**
 * Polygon.io Service
 * Real-time stock data with 1-minute bars
 */

import { restClient, GetStocksAggregatesTimespanEnum } from '@polygon.io/client-js';
import { config } from '../config.js';

let client: ReturnType<typeof restClient> | null = null;

// Track subscribed symbols
const subscribedSymbols = new Set<string>();
const lastQuotes = new Map<string, any>();
const lastBars = new Map<string, any[]>();

export async function initPolygon(): Promise<void> {
  if (!config.polygonApiKey) {
    throw new Error('Polygon API key not configured');
  }

  client = restClient(config.polygonApiKey);

  console.log('Polygon.io client initialized');
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

  try {
    const quote = await client.getLastStocksQuote(upperSymbol);
    lastQuotes.set(upperSymbol, {
      symbol: upperSymbol,
      bid: (quote.results as any)?.b || (quote.results as any)?.BP || 0,
      ask: (quote.results as any)?.a || (quote.results as any)?.AP || 0,
      last: (quote.results as any)?.p || (quote.results as any)?.P || 0,
      volume: (quote.results as any)?.v || (quote.results as any)?.V || 0,
      timestamp: quote.results?.t ? new Date(quote.results.t).toISOString() : null,
    });

    // Broadcast to WebSocket clients
    broadcastUpdate({
      type: 'quote',
      symbol: upperSymbol,
      data: lastQuotes.get(upperSymbol),
    });
  } catch (error) {
    console.error(`Error subscribing to ${symbol}:`, error);
  }
}

/**
 * Subscribe to multiple stocks
 */
export async function subscribeToStocks(): Promise<void> {
  if (!client) {
    console.log('Cannot subscribe - Polygon client not initialized');
    return;
  }

  // Subscribe to common market symbols
  const defaultSymbols = ['SPY', 'QQQ', 'IWM'];

  for (const symbol of defaultSymbols) {
    await subscribeToStock(symbol);
  }

  console.log(`Subscribed to ${subscribedSymbols.size} symbols`);
}

/**
 * Get real-time quote for a symbol
 */
export async function getRealTimeQuote(symbol: string): Promise<any> {
  if (!client) {
    throw new Error('Polygon client not initialized');
  }

  try {
    const quote = await client.getLastStocksQuote(symbol.toUpperCase());
    return {
      symbol: symbol.toUpperCase(),
      bid: (quote.results as any)?.b || (quote.results as any)?.BP || 0,
      ask: (quote.results as any)?.a || (quote.results as any)?.AP || 0,
      last: (quote.results as any)?.p || (quote.results as any)?.P || 0,
      volume: (quote.results as any)?.v || (quote.results as any)?.V || 0,
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
    const response = await client.getStocksAggregates(
      symbol.toUpperCase(),
      1,
      GetStocksAggregatesTimespanEnum.Minute,
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

  const timespanEnum = timespan === 'minute' ? GetStocksAggregatesTimespanEnum.Minute :
                        timespan === 'hour' ? GetStocksAggregatesTimespanEnum.Hour :
                        timespan === 'day' ? GetStocksAggregatesTimespanEnum.Day :
                        timespan === 'week' ? GetStocksAggregatesTimespanEnum.Week :
                        GetStocksAggregatesTimespanEnum.Month;

  try {
    const response = await client.getStocksAggregates(
      symbol.toUpperCase(),
      multiplier,
      timespanEnum,
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
    const response = await client.getStocksAggregates(
      symbol.toUpperCase(),
      1,
      GetStocksAggregatesTimespanEnum.Day,
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

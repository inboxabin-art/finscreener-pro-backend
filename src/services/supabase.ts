/**
 * Supabase Service
 * Database operations for stocks, alerts, and news
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let supabase: SupabaseClient | null = null;

export async function initSupabase(): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.log('⚠️ Supabase not configured');
    return;
  }

  supabase = createClient(config.supabaseUrl, config.supabaseKey);

  // Test connection
  try {
    const { data, error } = await supabase.from('stocks').select('id').limit(1);
    if (error) {
      console.error('⚠️ Supabase connection error:', error.message);
    } else {
      console.log('✅ Supabase connected');
    }
  } catch (error) {
    console.error('⚠️ Supabase connection failed:', error);
  }
}

/**
 * Get all stocks
 */
export async function getStocks(): Promise<any[]> {
  if (!supabase) {
    console.log('⚠️ Supabase not configured, returning empty array');
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .eq('isActive', true)
      .order('screenedDate', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching stocks:', error);
    return [];
  }
}

/**
 * Get stocks by screening date
 */
export async function getStocksByDate(date: string): Promise<any[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .eq('screenedDate', date);

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching stocks by date:', error);
    return [];
  }
}

/**
 * Get a single stock by ID
 */
export async function getStock(id: string): Promise<any | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching stock:', error);
    return null;
  }
}

/**
 * Get a single stock by symbol
 */
export async function getStockBySymbol(symbol: string): Promise<any | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .eq('symbol', symbol.toUpperCase())
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching stock by symbol:', error);
    return null;
  }
}

/**
 * Create a stock
 */
export async function createStock(stock: any): Promise<any> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('stocks')
    .insert([stock])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update a stock
 */
export async function updateStock(id: string, updates: any): Promise<any> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('stocks')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get all alerts
 */
export async function getAlerts(status?: string): Promise<any[]> {
  if (!supabase) return [];

  try {
    let query = supabase
      .from('alerts')
      .select('*, stock:stocks(*)')
      .order('generatedAt', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return [];
  }
}

/**
 * Get active alerts
 */
export async function getActiveAlerts(): Promise<any[]> {
  return getAlerts('active');
}

/**
 * Create an alert
 */
export async function createAlert(alert: any): Promise<any> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('alerts')
    .insert([{
      ...alert,
      status: 'active',
      generatedAt: new Date().toISOString(),
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update an alert
 */
export async function updateAlert(id: string, updates: any): Promise<any> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('alerts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Trigger an alert (enter trade)
 */
export async function triggerAlert(id: string, entryPrice: number): Promise<any> {
  return updateAlert(id, {
    status: 'triggered',
    entryPrice,
    entryTime: new Date().toISOString(),
    triggeredAt: new Date().toISOString(),
  });
}

/**
 * Close an alert (exit trade)
 */
export async function closeAlert(
  id: string,
  exitPrice: number,
  reason: string
): Promise<any> {
  const alert = await getAlertById(id);
  if (!alert) throw new Error('Alert not found');

  const entryPrice = alert.entryPrice || alert.alertPrice;
  const pnl = exitPrice - entryPrice;
  const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;

  const updated = await updateAlert(id, {
    status: 'closed',
    exitPrice,
    exitTime: new Date().toISOString(),
    notes: reason,
  });

  // Create performance record
  if (supabase) {
    await supabase.from('alert_performances').insert([{
      alertId: id,
      entryPrice,
      exitPrice,
      pnl,
      pnlPercent,
      exitedBy: reason,
      createdAt: new Date().toISOString(),
    }]);
  }

  return updated;
}

/**
 * Get alert by ID
 */
export async function getAlertById(id: string): Promise<any | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('alerts')
    .select('*, stock:stocks(*)')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

/**
 * Get news for a stock
 */
export async function getNews(stockId: string): Promise<any[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('news')
      .select('*')
      .eq('stockId', stockId)
      .order('publishedAt', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching news:', error);
    return [];
  }
}

/**
 * Create news item
 */
export async function createNews(news: any): Promise<any> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('news')
    .insert([news])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get recent predictions
 */
export async function getRecentPredictions(days: number = 30): Promise<any[]> {
  if (!supabase) return [];

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('sp500_predictions')
      .select('*')
      .gte('predictionTime', cutoff)
      .order('predictionTime', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching predictions:', error);
    return [];
  }
}

/**
 * Get performance statistics
 */
export async function getPerformanceStats(): Promise<any> {
  if (!supabase) {
    return { totalTrades: 0, winRate: 0, avgPnL: 0 };
  }

  try {
    const { data, error } = await supabase
      .from('alert_performances')
      .select('*');

    if (error) throw error;

    const performances = data || [];
    const wins = performances.filter(p => (p.pnl || 0) > 0);
    const totalPnL = performances.reduce((sum, p) => sum + (p.pnl || 0), 0);

    return {
      totalTrades: performances.length,
      wins: wins.length,
      losses: performances.length - wins.length,
      winRate: performances.length > 0 ? (wins.length / performances.length) * 100 : 0,
      avgPnL: performances.length > 0 ? totalPnL / performances.length : 0,
      totalPnL,
    };
  } catch (error) {
    console.error('Error fetching performance stats:', error);
    return { totalTrades: 0, winRate: 0, avgPnL: 0 };
  }
}

/**
 * Bulk create stocks
 */
export async function bulkCreateStocks(stocks: any[]): Promise<any[]> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('stocks')
    .insert(stocks)
    .select();

  if (error) throw error;
  return data || [];
}

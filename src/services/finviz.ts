/**
 * Finviz Service
 * Fetches stock data from Finviz Elite screener
 */

import { config } from '../config.js';
import { bulkCreateStocks, getStockBySymbol } from './supabase.js';

const FINVIZ_BASE_URL = 'https://elite.finviz.com';

interface FinvizStock {
  symbol: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  relativeVolume: number;
  newsTime: string;
  priceSMA20: number;
  priceSMA50: number;
  priceSMA200: number;
  high52: number;
  low52: number;
  beta: number;
  roa: number;
  roe: number;
  roi: number;
  debtEq: number;
  epsYoY: number;
  epsQYoY: number;
  epsPast5Y: number;
  epsNext5Y: number;
  salesPast5Y: number;
  priceChange: number;
  forwardPE: number;
  peg: number;
  pci: number;
  assets: number;
  debt: number;
  dividend: number;
  dividendPercent: number;
}

interface ScreenerParams {
  view?: string;        // 111 = overview, 121 = valuation, etc.
  filter?: string;       // Comma-separated filters
  sort?: string;         // Sorting field
  order?: 'asc' | 'desc';
  preset?: string;      // Preset screener ID
}

export class FinvizService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Build screener URL with filters
   */
  buildScreenerUrl(params: ScreenerParams = {}): string {
    const {
      view = '111',      // Overview view
      filter = '',
      sort = 'change',
      order = 'desc'
    } = params;

    const url = new URL(`${FINVIZ_BASE_URL}/export.ashx`);
    url.searchParams.set('v', view);
    url.searchParams.set('auth', this.apiKey);

    if (filter) {
      url.searchParams.set('f', filter);
    }

    url.searchParams.set('o', `-${sort}`);

    return url.toString();
  }

  /**
   * Parse CSV response from Finviz
   */
  private parseCSV(csvText: string): FinvizStock[] {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const stocks: FinvizStock[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (values.length !== headers.length) continue;

      const stock: any = {};
      headers.forEach((header, index) => {
        const value = values[index]?.trim() || '';
        stock[header] = this.convertValue(header, value);
      });

      if (stock.symbol && stock.symbol !== 'N/A') {
        stocks.push(stock as FinvizStock);
      }
    }

    return stocks;
  }

  /**
   * Parse CSV line handling quoted values
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);

    return result.map(v => v.replace(/^"|"$/g, ''));
  }

  /**
   * Convert string values to appropriate types
   */
  private convertValue(field: string, value: string): any {
    if (!value || value === 'N/A' || value === '-') return null;

    // Market cap
    if (field === 'marketcap') {
      const match = value.match(/([0-9.]+)([TMBK])/);
      if (match) {
        const num = parseFloat(match[1]);
        const suffix = match[2];
        switch (suffix) {
          case 'T': return num * 1e12;
          case 'B': return num * 1e9;
          case 'M': return num * 1e6;
          case 'K': return num * 1e3;
        }
      }
      return parseFloat(value);
    }

    // Percentage fields
    if (field.includes('percent') || field.includes('change') ||
        field.includes('roe') || field.includes('roa') || field.includes('roi') ||
        field.includes('peg') || field.includes('beta') ||
        field.includes('pci') || field.includes('div')) {
      return parseFloat(value.replace('%', ''));
    }

    // Price and volume
    if (field === 'price' || field === 'high' || field === 'low' ||
        field === 'sma20' || field === 'sma50' || field === 'sma200' ||
        field === 'forwardpe') {
      return parseFloat(value);
    }

    if (field === 'volume') {
      return parseInt(value.replace(/,/g, ''));
    }

    if (field === 'relvol') {
      return parseFloat(value);
    }

    // Date fields
    if (field === 'newstime') {
      return value;
    }

    return value;
  }

  /**
   * Fetch stocks from Finviz screener
   */
  async fetchScreener(params: ScreenerParams = {}): Promise<FinvizStock[]> {
    const url = this.buildScreenerUrl(params);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
      });

      if (!response.ok) {
        throw new Error(`Finviz API error: ${response.status}`);
      }

      const csvText = await response.text();
      return this.parseCSV(csvText);
    } catch (error) {
      console.error('Error fetching from Finviz:', error);
      return [];
    }
  }

  /**
   * Fetch with default tech/growth filters
   */
  async fetchTechGrowthStocks(): Promise<FinvizStock[]> {
    // Filter: Technology sector, small cap+, curr ratio >1.5, EPS yoy >20%,
    // news last 24h, rel vol >1.5, above SMA20
    const filter = 'sec_technology,cap_smallover,fa_curratio_o1.5,fa_epsyoy_o20,news_prevahours24,sh_relvol_o1.5,ta_sma20_pa';

    return this.fetchScreener({
      view: '111',
      filter,
      sort: 'change',
      order: 'desc'
    });
  }

  /**
   * Fetch stocks with specific filters
   */
  async fetchWithFilters(filters: string): Promise<FinvizStock[]> {
    return this.fetchScreener({
      view: '111',
      filter: filters,
      sort: 'change',
      order: 'desc'
    });
  }

  /**
   * Fetch and save to database
   */
  async fetchAndSaveStocks(filters?: string): Promise<number> {
    const stocks = filters
      ? await this.fetchWithFilters(filters)
      : await this.fetchTechGrowthStocks();

    if (stocks.length === 0) {
      console.log('No stocks fetched from Finviz');
      return 0;
    }

    const today = new Date().toISOString().split('T')[0];
    let savedCount = 0;

    for (const stock of stocks) {
      try {
        // Check if stock already exists for today
        const existing = await getStockBySymbol(stock.symbol);

        const s = stock as any;
        const stockData = {
          symbol: s.symbol,
          company: s.company,
          sector: s.sector,
          industry: s.industry,
          marketCap: s.marketcap,
          price: s.price,
          change: s.change,
          changePercent: s.changepercent,
          volume: s.volume,
          relativeVolume: s.relvol,
          newsTime: s.newstime,
          priceSMA20: s.pricesma20,
          priceSMA50: s.pricesma50,
          priceSMA200: s.pricesma200,
          high52: s.high52,
          low52: s.low52,
          beta: s.beta,
          roa: s.roa,
          roe: s.roe,
          roi: s.roi,
          debtEq: s.debteq,
          epsYoY: s.epsyoy,
          epsQYoY: s.epsqoq,
          epsPast5Y: s.epsPast5Y,
          epsNext5Y: s.epsnext5y,
          salesPast5Y: s.salespast5y,
          forwardPE: s.forwardpe,
          peg: s.peg,
          dividend: s.dividend,
          dividendPercent: s.dividendpercent,
          screenedDate: today,
          source: 'finviz',
          isActive: true,
          metadata: stock
        };

        if (!existing) {
          await bulkCreateStocks([stockData]);
          savedCount++;
        }
      } catch (error) {
        console.error(`Error saving stock ${stock.symbol}:`, error);
      }
    }

    console.log(`Saved ${savedCount} new stocks from Finviz`);
    return savedCount;
  }
}

// Singleton instance
let finvizService: FinvizService | null = null;

export function initFinviz(): FinvizService {
  if (!config.finvizApiKey) {
    console.warn('⚠️ Finviz API key not configured');
    return null as any;
  }

  if (!finvizService) {
    finvizService = new FinvizService(config.finvizApiKey);
    console.log('✅ Finviz service initialized');
  }

  return finvizService;
}

export function getFinvizService(): FinvizService | null {
  return finvizService;
}

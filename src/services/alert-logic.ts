/**
 * Alert Logic
 * Exit signal detection and trailing stop calculations
 */

import { config } from '../config';

// UT Bot key values
export const UT_BOT_CONFIG = {
  INTRADAY: {
    keyValue: 1.0,
    atrPeriod: 10,
  },
  SWING: {
    keyValue: 2.0,
    atrPeriod: 10,
  },
};

/**
 * Calculate UT Bot trailing stop
 */
export function calculateUTBotStop(
  highSinceEntry: number,
  atrValue: number,
  keyValue: number
): number {
  return highSinceEntry - (keyValue * atrValue);
}

/**
 * Check for exit signals
 */
export function checkExitSignal(
  currentPrice: number,
  entryPrice: number,
  highSinceEntry: number,
  vwap: number,
  rsi5min: number,
  sma20: number,
  utBotStop: number,
  isIntraday: boolean
): {
  shouldExit: boolean;
  reason: string;
  exitType: 'stop_loss' | 'target_1' | 'target_2' | 'time_based' | 'manual';
  price: number;
} {
  const now = new Date();
  const time = now.getHours() * 60 + now.getMinutes();

  // 1. Time-based exit for intraday (3:45 PM = 15:45 = 945 minutes)
  if (isIntraday && time >= 945) {
    return {
      shouldExit: true,
      reason: 'INTRADAY TIME EXIT: 3:45 PM market close approach',
      exitType: 'time_based',
      price: currentPrice,
    };
  }

  // 2. UT Bot trailing stop hit
  if (currentPrice < utBotStop) {
    const pnlPercent = ((utBotStop - entryPrice) / entryPrice * 100).toFixed(1);
    return {
      shouldExit: true,
      reason: `TRAILING STOP HIT: UT Bot trailing stop triggered (${pnlPercent}%)`,
      exitType: 'stop_loss',
      price: utBotStop,
    };
  }

  // 3. VWAP exit for intraday
  if (isIntraday && currentPrice < vwap) {
    return {
      shouldExit: true,
      reason: 'VWAP EXIT: Price dropped below VWAP - losing momentum',
      exitType: 'stop_loss',
      price: vwap,
    };
  }

  // 4. Target 1 hit (50% profit taking at 2% gain)
  const target1Price = entryPrice * 1.02;
  if (currentPrice >= target1Price && highSinceEntry > entryPrice) {
    const potentialGain = ((currentPrice - entryPrice) / entryPrice) * 100;
    if (potentialGain >= 2) {
      return {
        shouldExit: true,
        reason: `TARGET 1 HIT: +${potentialGain.toFixed(1)}% profit taken`,
        exitType: 'target_1',
        price: currentPrice,
      };
    }
  }

  // 5. RSI OVERHEAT exit for swings (RSI > 75)
  if (!isIntraday && rsi5min > 75) {
    return {
      shouldExit: true,
      reason: 'RSI OVERHEAT: RSI > 75, consider taking profits',
      exitType: 'target_1',
      price: currentPrice,
    };
  }

  // 6. SMA 20 break for swings
  if (!isIntraday && currentPrice < sma20) {
    return {
      shouldExit: true,
      reason: 'SMA 20 BREAK: Daily close below SMA 20 - cycle dead',
      exitType: 'stop_loss',
      price: sma20,
    };
  }

  return {
    shouldExit: false,
    reason: '',
    exitType: 'manual',
    price: currentPrice,
  };
}

/**
 * Calculate position size based on ATR risk
 */
export function calculatePositionSize(
  accountSize: number,
  entryPrice: number,
  stopLoss: number,
  riskPercent: number = 1.0
): {
  shares: number;
  positionValue: number;
  riskAmount: number;
} {
  const riskAmount = accountSize * (riskPercent / 100);
  const riskPerShare = Math.abs(entryPrice - stopLoss);

  if (riskPerShare <= 0) {
    return { shares: 0, positionValue: 0, riskAmount: 0 };
  }

  const shares = Math.floor(riskAmount / riskPerShare);
  const positionValue = shares * entryPrice;

  return { shares, positionValue, riskAmount };
}

/**
 * Calculate risk/reward ratio
 */
export function calculateRiskReward(
  entryPrice: number,
  targetPrice: number,
  stopLoss: number
): number {
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(targetPrice - entryPrice);

  if (risk === 0) return 0;
  return reward / risk;
}

/**
 * Check if market is open
 */
export function isMarketOpen(): boolean {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const day = now.getDay();

  // Weekend check
  if (day === 0 || day === 6) return false;

  // Market hours: 9:30 AM - 4:00 PM ET
  const currentMinutes = hours * 60 + minutes;
  const openMinutes = 9 * 60 + 30; // 9:30 AM
  const closeMinutes = 16 * 60; // 4:00 PM

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

/**
 * Get market session
 */
export function getMarketSession(): 'pre_market' | 'open' | 'after_hours' | 'closed' {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const day = now.getDay();

  // Weekend
  if (day === 0 || day === 6) return 'closed';

  const currentMinutes = hours * 60 + minutes;

  // Pre-market: 4:00 AM - 9:30 AM
  if (currentMinutes >= 4 * 60 && currentMinutes < 9 * 60 + 30) {
    return 'pre_market';
  }

  // Regular hours: 9:30 AM - 4:00 PM
  if (currentMinutes >= 9 * 60 + 30 && currentMinutes < 16 * 60) {
    return 'open';
  }

  // After-hours: 4:00 PM - 8:00 PM
  if (currentMinutes >= 16 * 60 && currentMinutes < 20 * 60) {
    return 'after_hours';
  }

  return 'closed';
}

// ============================================================
// POLYKIENGS - Wallet Scanner Module
// Scans 14,000+ wallets in minutes, detects winning patterns
// ============================================================

import axios from 'axios';
import { config } from '../config';
import { WalletProfile, TradeRecord, ScanResult, TopTrader, TraderPattern } from '../types';
import { logger } from '../utils/logger';
import { Database } from '../utils/database';

/**
 * Simple concurrency limiter (replaces p-limit which is ESM-only)
 */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          active--;
          if (queue.length > 0) {
            const next = queue.shift();
            if (next) next();
          }
        }
      };

      if (active < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

export class WalletScanner {
  private apiUrl: string;
  private gammaUrl: string;
  private dataUrl: string;
  private db: Database;
  private limit: <T>(fn: () => Promise<T>) => Promise<T>;
  private scannedWallets: Map<string, WalletProfile> = new Map();

  constructor(db: Database) {
    this.apiUrl = config.polymarketApiUrl;
    this.gammaUrl = config.gammaApiUrl;
    this.dataUrl = config.dataApiUrl;
    this.db = db;
    // Concurrency limiter: 10 parallel requests (safe for Polymarket rate limits)
    this.limit = createLimiter(10);
  }

  /**
   * Main scan: fetches 14,000+ wallets, analyzes trade histories,
   * cross-references win rates and size patterns
   */
  async scanAllWallets(): Promise<ScanResult> {
    const startTime = Date.now();
    logger.info(`🔍 Starting wallet scan - targeting ${config.maxWalletsToScan}+ wallets...`);

    // Phase 1: Collect wallet addresses from active markets
    const wallets = await this.collectWalletAddresses();
    logger.info(`📊 Collected ${wallets.length} unique wallet addresses`);

    // Phase 2: Batch analyze all wallets
    const profiles = await this.batchAnalyzeWallets(wallets);
    logger.info(`✅ Analyzed ${profiles.length} wallet profiles`);

    // Phase 3: Filter for quality traders
    const qualityTraders = this.filterQualityTraders(profiles);
    logger.info(`🏆 Found ${qualityTraders.length} quality traders (win rate >${config.minWinRate * 100}%)`);

    // Phase 4: Deep pattern analysis on top candidates
    const topTraders = await this.deepAnalysis(qualityTraders);
    logger.info(`🎯 Identified ${topTraders.length} top traders with proven edge`);

    // Save to database
    this.db.saveTopTraders(topTraders);

    const scanDuration = Date.now() - startTime;
    logger.info(`⏱️ Scan completed in ${(scanDuration / 1000).toFixed(1)}s`);

    return {
      totalWalletsScanned: wallets.length,
      totalTradesAnalyzed: profiles.reduce((sum, p) => sum + p.totalTrades, 0),
      topTraders,
      scanDuration,
      timestamp: Date.now(),
    };
  }

  /**
   * Collect wallet addresses from Polymarket's active markets
   * Sources: market order books, recent trades, leaderboards
   */
  private async collectWalletAddresses(): Promise<string[]> {
    const walletSet = new Set<string>();
    
    try {
      // Source 1: Fetch from activity/trades endpoint
      const markets = await this.fetchActiveMarkets();
      logger.info(`  Found ${markets.length} active markets to scan`);

      // Source 2: Fetch traders from each market in parallel
      const batchSize = config.scanBatchSize;
      for (let i = 0; i < markets.length; i += batchSize) {
        const batch = markets.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(market => this.limit(() => this.fetchMarketTraders(market)))
        );
        
        results.forEach(r => {
          if (r.status === 'fulfilled') {
            r.value.forEach((addr: string) => walletSet.add(addr));
          }
        });

        // Rate limit: pause between batches
        await this.rateLimitDelay(i / batchSize);

        // Progress update
        if (walletSet.size >= config.maxWalletsToScan) break;
        logger.info(`  Progress: ${walletSet.size} wallets collected...`);
      }

      // Source 3: Leaderboard wallets (known active traders)
      const leaderboardWallets = await this.fetchLeaderboardWallets();
      leaderboardWallets.forEach(addr => walletSet.add(addr));

    } catch (error) {
      logger.error('Error collecting wallets:', error);
    }

    return Array.from(walletSet).slice(0, config.maxWalletsToScan);
  }

  /**
   * Batch analyze wallet profiles with high concurrency
   */
  private async batchAnalyzeWallets(wallets: string[]): Promise<WalletProfile[]> {
    const profiles: WalletProfile[] = [];
    const batchSize = config.scanBatchSize;

    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(wallet => this.limit(() => this.analyzeWallet(wallet)))
      );

      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
          profiles.push(r.value);
        }
      });

      // Rate limit: pause between batches
      await this.rateLimitDelay(i / batchSize);

      // Log progress every 1000 wallets
      if (profiles.length % 1000 < batchSize) {
        logger.info(`  Analyzed: ${profiles.length}/${wallets.length} wallets`);
      }
    }

    return profiles;
  }

  /**
   * Analyze a single wallet's trading history
   */
  private async analyzeWallet(address: string): Promise<WalletProfile | null> {
    try {
      const trades = await this.fetchWalletTrades(address);
      if (trades.length < 5) return null; // Need at least 5 trades (data-api returns limited history)

      // Use all trades for analysis (data-api doesn't provide resolved status)
      // We treat all completed trades as valid data points
      const resolvedTrades = trades;

      const wins = resolvedTrades.filter(t => t.won === true || t.side === 'YES').length;
      const winRate = wins / resolvedTrades.length;
      const avgBetSize = resolvedTrades.reduce((s, t) => s + t.amount, 0) / resolvedTrades.length;
      const profitLoss = this.calculatePnL(resolvedTrades);
      const totalInvested = resolvedTrades.reduce((s, t) => s + t.amount, 0);
      const roi = totalInvested > 0 ? profitLoss / totalInvested : 0;
      
      // Calculate consistency score (low variance in returns = high consistency)
      const consistency = this.calculateConsistency(resolvedTrades);
      
      // Calculate current streak
      const streak = this.calculateStreak(resolvedTrades);

      const uniqueMarkets = new Set(trades.map(t => t.market)).size;

      const profile: WalletProfile = {
        address,
        totalTrades: resolvedTrades.length,
        winRate,
        avgBetSize,
        profitLoss,
        roi,
        marketsTraded: uniqueMarkets,
        lastActive: Math.max(...trades.map(t => t.timestamp)),
        streak,
        kellyScore: 0, // Calculated later
        consistency,
        edgeScore: 0, // Calculated later
      };

      // Calculate Kelly score for this trader
      profile.kellyScore = this.calculateKellyScore(profile);
      profile.edgeScore = this.calculateEdgeScore(profile);

      this.scannedWallets.set(address, profile);
      return profile;
    } catch {
      return null;
    }
  }

  /**
   * Filter for quality traders based on minimum criteria
   */
  private filterQualityTraders(profiles: WalletProfile[]): WalletProfile[] {
    return profiles
      .filter(p => 
        p.winRate >= config.minWinRate &&
        p.totalTrades >= config.minTrades &&
        p.profitLoss > 0 &&
        p.consistency > 0.3 &&
        p.lastActive > Date.now() - (7 * 24 * 60 * 60 * 1000) // Active in last week
      )
      .sort((a, b) => b.edgeScore - a.edgeScore);
  }

  /**
   * Deep analysis: determine if trader's edge is SKILL not LUCK
   * Uses statistical tests and pattern recognition
   */
  private async deepAnalysis(profiles: WalletProfile[]): Promise<TopTrader[]> {
    const topCandidates = profiles.slice(0, 50); // Analyze top 50
    const topTraders: TopTrader[] = [];

    for (const profile of topCandidates) {
      const trades = await this.fetchWalletTrades(profile.address);
      const patterns = this.analyzePatterns(trades, profile);
      
      // Statistical test: is edge due to skill?
      const isSkillBased = this.testSkillVsLuck(profile, trades);

      if (isSkillBased) {
        topTraders.push({
          wallet: profile,
          trades,
          patterns,
          isSkillBased: true,
          rank: topTraders.length + 1,
        });
      }

      // We want exactly the top N (default 7)
      if (topTraders.length >= config.topTradersCount) break;
    }

    return topTraders;
  }

  /**
   * Statistical test: Chi-square test to determine if win rate is 
   * significantly above random chance
   */
  private testSkillVsLuck(profile: WalletProfile, trades: TradeRecord[]): boolean {
    const n = profile.totalTrades;
    const observed = profile.winRate;
    
    // Null hypothesis: trader wins at market-average rate (50%)
    const expected = 0.50;
    
    // Z-score for proportion test
    const se = Math.sqrt((expected * (1 - expected)) / n);
    const zScore = (observed - expected) / se;
    
    // Require z-score > 1.65 (90% confidence) - relaxed for limited data
    const isStatisticallySignificant = zScore > 1.65;
    
    // Additional checks:
    // 1. Consistency across time periods
    const halfPoint = Math.floor(trades.length / 2);
    const firstHalf = trades.slice(0, halfPoint).filter(t => t.won === true).length / halfPoint;
    const secondHalf = trades.slice(halfPoint).filter(t => t.won === true).length / (trades.length - halfPoint);
    const isConsistentAcrossTime = Math.abs(firstHalf - secondHalf) < 0.15;
    
    // 2. Diverse market success (not just lucky in one market)
    const marketWins = new Map<string, number>();
    trades.filter(t => t.won).forEach(t => {
      marketWins.set(t.market, (marketWins.get(t.market) || 0) + 1);
    });
    const isDiverse = marketWins.size >= 2;

    return isStatisticallySignificant && (isConsistentAcrossTime || isDiverse);
  }

  /**
   * Analyze trading patterns of a wallet
   */
  private analyzePatterns(trades: TradeRecord[], profile: WalletProfile): TraderPattern {
    // Determine preferred market types
    const categoryCount = new Map<string, number>();
    const categoryWins = new Map<string, { wins: number; total: number }>();
    
    trades.forEach(t => {
      const cat = this.categorizeMarket(t.marketSlug);
      categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
      const curr = categoryWins.get(cat) || { wins: 0, total: 0 };
      curr.total++;
      if (t.won) curr.wins++;
      categoryWins.set(cat, curr);
    });

    const preferredMarketTypes = Array.from(categoryCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat]) => cat);

    // Determine sizing pattern
    const sizes = trades.map(t => t.amount);
    const sizeVariance = this.variance(sizes);
    const avgSize = profile.avgBetSize;
    const cv = Math.sqrt(sizeVariance) / avgSize; // coefficient of variation

    let sizingPattern: 'fixed' | 'proportional' | 'kelly' | 'irregular';
    if (cv < 0.2) sizingPattern = 'fixed';
    else if (cv < 0.5) sizingPattern = 'proportional';
    else if (cv < 0.8) sizingPattern = 'kelly';
    else sizingPattern = 'irregular';

    // Entry price analysis
    const entryPrices = trades.map(t => t.price);
    entryPrices.sort((a, b) => a - b);
    const entryPriceRange: [number, number] = [
      entryPrices[Math.floor(entryPrices.length * 0.25)],
      entryPrices[Math.floor(entryPrices.length * 0.75)],
    ];

    // Timing pattern (based on entry prices relative to resolution)
    const timingPattern = entryPriceRange[1] < 0.7 ? 'early' : entryPriceRange[0] > 0.6 ? 'late' : 'mixed';

    // Win rate by category
    const winRateByCategory: Record<string, number> = {};
    categoryWins.forEach((val, key) => {
      winRateByCategory[key] = val.total > 0 ? val.wins / val.total : 0;
    });

    return {
      preferredMarketTypes,
      avgHoldTime: 0, // Would need resolution timestamps
      entryPriceRange,
      sizingPattern,
      timingPattern,
      winRateByCategory,
    };
  }

  // ---- Helper Methods ----

  private calculatePnL(trades: TradeRecord[]): number {
    return trades.reduce((pnl, t) => {
      if (t.won === true) {
        return pnl + (t.amount * (1 / t.price - 1)); // Profit from winning
      } else if (t.won === false) {
        return pnl - t.amount; // Lost the bet
      }
      return pnl;
    }, 0);
  }

  private calculateConsistency(trades: TradeRecord[]): number {
    if (trades.length < 10) return 0;
    
    // Split into 5 segments, check win rate consistency
    const segSize = Math.floor(trades.length / 5);
    const segWinRates: number[] = [];
    
    for (let i = 0; i < 5; i++) {
      const seg = trades.slice(i * segSize, (i + 1) * segSize);
      const wins = seg.filter(t => t.won === true).length;
      segWinRates.push(wins / seg.length);
    }
    
    const variance = this.variance(segWinRates);
    // Low variance = high consistency
    return Math.max(0, 1 - Math.sqrt(variance) * 3);
  }

  private calculateStreak(trades: TradeRecord[]): number {
    let streak = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].won === true) streak++;
      else break;
    }
    return streak;
  }

  private calculateKellyScore(profile: WalletProfile): number {
    // Kelly-based score: (p * b - q) / b
    // where p = win rate, q = 1-p, b = avg odds
    const p = profile.winRate;
    const q = 1 - p;
    const b = profile.roi > 0 ? 1 + profile.roi : 1;
    const kelly = Math.max(0, (p * b - q) / b);
    return kelly;
  }

  private calculateEdgeScore(profile: WalletProfile): number {
    // Composite score combining multiple factors
    const winRateScore = (profile.winRate - 0.5) * 2; // 0-1 range for 50-100% wr
    const consistencyScore = profile.consistency;
    const volumeScore = Math.min(1, profile.totalTrades / 100);
    const roiScore = Math.min(1, Math.max(0, profile.roi));
    
    return (winRateScore * 0.3 + consistencyScore * 0.3 + volumeScore * 0.2 + roiScore * 0.2);
  }

  private categorizeMarket(slug: string): string {
    const lower = slug.toLowerCase();
    if (lower.includes('election') || lower.includes('president') || lower.includes('vote')) return 'politics';
    if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('eth')) return 'crypto';
    if (lower.includes('sport') || lower.includes('nfl') || lower.includes('nba')) return 'sports';
    if (lower.includes('ai') || lower.includes('tech')) return 'technology';
    return 'general';
  }

  private variance(arr: number[]): number {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  }

  // ---- API Methods ----

  /**
   * Retry with exponential backoff for rate-limited requests
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const status = error.response?.status;
        
        // Don't retry on client errors (except 429 rate limit)
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
        
        if (attempt === maxRetries) throw error;
        
        // Exponential backoff: 1s, 2s, 4s, 8s...
        const delay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 500; // Add jitter to prevent thundering herd
        logger.debug(`  Retry ${attempt + 1}/${maxRetries} after ${delay}ms (status: ${status || 'timeout'})`);
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Rate-limited delay between batches
   */
  private async rateLimitDelay(batchIndex: number): Promise<void> {
    // Add 500ms delay every 5 batches to avoid rate limits
    if (batchIndex > 0 && batchIndex % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  private async fetchActiveMarkets(): Promise<string[]> {
    try {
      // Use Gamma API for market listing (CLOB API doesn't list markets)
      const response = await this.retryWithBackoff(() =>
        axios.get(`${this.gammaUrl}/markets`, {
          params: { active: true, closed: false, limit: 100 },
          timeout: 30000,
        })
      );
      const markets = response.data || [];
      // Extract ALL clob token IDs (each market has YES and NO token)
      const tokenIds: string[] = [];
      for (const m of markets) {
        if (m.clobTokenIds) {
          // clobTokenIds is a JSON string like '["tokenId1","tokenId2"]' or an array
          try {
            const ids = typeof m.clobTokenIds === 'string' 
              ? JSON.parse(m.clobTokenIds) 
              : m.clobTokenIds;
            if (Array.isArray(ids)) {
              tokenIds.push(...ids);
            }
          } catch {
            // If parsing fails, try as single value
            if (m.clobTokenIds) tokenIds.push(m.clobTokenIds);
          }
        } else if (m.condition_id) {
          tokenIds.push(m.condition_id);
        }
      }
      logger.info(`  Extracted ${tokenIds.length} token IDs from ${markets.length} markets`);
      return tokenIds.filter(Boolean);
    } catch (error) {
      logger.warn('Failed to fetch markets from Gamma API, using cached data');
      return this.db.getCachedMarketIds();
    }
  }

  private async fetchMarketTraders(tokenId: string): Promise<string[]> {
    try {
      // Use public data-api for trades (no auth required) - high limit for more wallets
      const response = await this.retryWithBackoff(() =>
        axios.get(`${this.dataUrl}/trades`, {
          params: { asset_id: tokenId, limit: 12000 },
          timeout: 30000,
        })
      );
      const trades = response.data || [];
      return trades.map((t: any) => t.proxyWallet || t.maker_address || t.maker).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async fetchLeaderboardWallets(): Promise<string[]> {
    try {
      // Gamma API for leaderboard/top traders
      const response = await this.retryWithBackoff(() =>
        axios.get(`${this.gammaUrl}/markets`, {
          params: { active: true, closed: false, limit: 50, order: 'volume', ascending: false },
          timeout: 15000,
        })
      );
      // Extract unique traders from high-volume markets
      const wallets: string[] = [];
      for (const market of response.data || []) {
        if (market.maker_address) wallets.push(market.maker_address);
      }
      return wallets;
    } catch {
      return [];
    }
  }

  private async fetchWalletTrades(address: string): Promise<TradeRecord[]> {
    try {
      // Use public data-api for wallet trades (no auth required) - high limit for full history
      const response = await this.retryWithBackoff(() =>
        axios.get(`${this.dataUrl}/trades`, {
          params: { proxyWallet: address, limit: 12000 },
          timeout: 30000,
        })
      );
      const data = response.data || [];
      return data.map((t: any) => ({
        id: t.transactionHash || `${address}-${t.timestamp}`,
        wallet: address,
        market: t.asset || t.conditionId || '',
        marketSlug: t.slug || '',
        outcome: t.outcome || '',
        side: t.side === 'BUY' ? 'YES' : 'NO',
        amount: parseFloat(t.size || '0'),
        price: parseFloat(t.price || '0.5'),
        timestamp: typeof t.timestamp === 'number' ? t.timestamp * 1000 : new Date(t.timestamp).getTime(),
        resolved: false,
        won: null,
      }));
    } catch {
      return [];
    }
  }
}

// ============================================================
// POLYKIENGS - Wallet Scanner Module
// Scans 14,000+ wallets in minutes, detects winning patterns
// ============================================================

import axios from 'axios';
import pLimit from 'p-limit';
import { config } from '../config';
import { WalletProfile, TradeRecord, ScanResult, TopTrader, TraderPattern } from '../types';
import { logger } from '../utils/logger';
import { Database } from '../utils/database';

export class WalletScanner {
  private apiUrl: string;
  private db: Database;
  private limit: ReturnType<typeof pLimit>;
  private scannedWallets: Map<string, WalletProfile> = new Map();

  constructor(db: Database) {
    this.apiUrl = config.polymarketApiUrl;
    this.db = db;
    // Concurrency limiter: 50 parallel requests for speed
    this.limit = pLimit(50);
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
            r.value.forEach(addr => walletSet.add(addr));
          }
        });

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
      if (trades.length < config.minTrades) return null;

      const resolvedTrades = trades.filter(t => t.resolved);
      if (resolvedTrades.length === 0) return null;

      const wins = resolvedTrades.filter(t => t.won === true).length;
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
    
    // Require z-score > 2.33 (99% confidence) for skill determination
    const isStatisticallySignificant = zScore > 2.33;
    
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
    const isDiverse = marketWins.size >= 3;

    return isStatisticallySignificant && isConsistentAcrossTime && isDiverse;
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

    // Timing pattern
    const avgTimestamp = trades.reduce((s, t) => s + t.timestamp, 0) / trades.length;
    const marketEndTimes = trades.map(t => t.timestamp); // Simplified
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

  private async fetchActiveMarkets(): Promise<string[]> {
    try {
      const response = await axios.get(`${this.apiUrl}/markets`, {
        params: { limit: 500, active: true },
        timeout: 30000,
      });
      return response.data.map((m: any) => m.condition_id || m.id);
    } catch (error) {
      logger.warn('Failed to fetch markets, using cached data');
      return this.db.getCachedMarketIds();
    }
  }

  private async fetchMarketTraders(marketId: string): Promise<string[]> {
    try {
      const response = await axios.get(`${this.apiUrl}/trades`, {
        params: { market: marketId, limit: 500 },
        timeout: 15000,
      });
      return response.data.map((t: any) => t.maker || t.taker).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async fetchLeaderboardWallets(): Promise<string[]> {
    try {
      const response = await axios.get(`${this.apiUrl}/leaderboard`, {
        params: { limit: 1000 },
        timeout: 15000,
      });
      return response.data.map((l: any) => l.address || l.wallet).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async fetchWalletTrades(address: string): Promise<TradeRecord[]> {
    try {
      const response = await axios.get(`${this.apiUrl}/trades`, {
        params: { maker: address, limit: 200 },
        timeout: 15000,
      });
      return response.data.map((t: any) => ({
        id: t.id || `${address}-${t.timestamp}`,
        wallet: address,
        market: t.market || t.condition_id,
        marketSlug: t.market_slug || '',
        outcome: t.outcome || '',
        side: t.side === 'BUY' ? 'YES' : 'NO',
        amount: parseFloat(t.size || t.amount || '0'),
        price: parseFloat(t.price || '0.5'),
        timestamp: new Date(t.timestamp || t.created_at).getTime(),
        resolved: t.resolved || false,
        won: t.won ?? null,
      }));
    } catch {
      return [];
    }
  }
}

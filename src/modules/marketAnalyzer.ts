// ============================================================
// POLYKIENGS - Market Analyzer Module
// Identifies markets with edge opportunities
// Cross-references win rates and bet size patterns
// ============================================================

import axios from 'axios';
import { config } from '../config';
import { MarketData, TopTrader, KellyBet, TradeRecord } from '../types';
import { logger } from '../utils/logger';
import { KellyCriterion } from './kellyCriterion';
import { Database } from '../utils/database';

export class MarketAnalyzer {
  private apiUrl: string;
  private gammaUrl: string;
  private kelly: KellyCriterion;
  private db: Database;
  private marketsCache: Map<string, MarketData> = new Map();

  constructor(kelly: KellyCriterion, db: Database) {
    this.apiUrl = config.polymarketApiUrl;
    this.gammaUrl = config.gammaApiUrl;
    this.kelly = kelly;
    this.db = db;
  }

  /**
   * Main analysis: find the best trading opportunities
   * by cross-referencing top trader positions with market data
   */
  async findOpportunities(
    topTraders: TopTrader[],
    bankroll: number,
    activeBetsCount: number
  ): Promise<KellyBet[]> {
    logger.info('🔬 Analyzing markets for opportunities...');

    // Step 1: Get current active markets
    const markets = await this.fetchActiveMarkets();
    logger.info(`  ${markets.length} active markets found`);

    // Step 2: Find markets where top traders have positions
    const traderMarkets = this.findTraderConvergence(topTraders, markets);
    logger.info(`  ${traderMarkets.length} markets with trader activity`);

    // Step 3: For each market, calculate our edge
    const opportunities: KellyBet[] = [];

    for (const { market, traders, recentTrades } of traderMarkets) {
      const opportunity = this.evaluateOpportunity(market, traders, recentTrades, bankroll);
      if (opportunity) {
        opportunities.push(opportunity);
      }
    }

    logger.info(`  🎯 ${opportunities.length} opportunities with positive edge found`);

    // Step 4: Optimize portfolio allocation
    const optimized = this.kelly.optimizePortfolio(opportunities, bankroll, activeBetsCount);
    logger.info(`  💰 ${optimized.length} trades recommended after portfolio optimization`);

    return optimized;
  }

  /**
   * Find markets where top traders have recent activity
   * Relaxed: even 1 trader with high conviction is enough
   */
  private findTraderConvergence(
    topTraders: TopTrader[],
    markets: MarketData[]
  ): { market: MarketData; traders: TopTrader[]; recentTrades: TradeRecord[] }[] {
    const marketTraderMap = new Map<string, { traders: TopTrader[]; trades: TradeRecord[] }>();

    // Build a set of market IDs for quick lookup
    const marketIds = new Set(markets.map(m => m.id));
    const marketBySlug = new Map(markets.map(m => [m.slug, m]));

    for (const trader of topTraders) {
      // Get recent trades (last 7 days - relaxed from 48h)
      const recentCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const recentTrades = trader.trades.filter(t => t.timestamp > recentCutoff);

      for (const trade of recentTrades) {
        const existing = marketTraderMap.get(trade.market) || { traders: [], trades: [] };
        if (!existing.traders.includes(trader)) {
          existing.traders.push(trader);
        }
        existing.trades.push(trade);
        marketTraderMap.set(trade.market, existing);
      }
    }

    // Return markets with 1+ traders (relaxed from 2+)
    const convergent: { market: MarketData; traders: TopTrader[]; recentTrades: TradeRecord[] }[] = [];
    
    for (const [marketId, { traders, trades }] of marketTraderMap) {
      // Try to match market by ID or by slug
      let market = markets.find(m => m.id === marketId);
      if (!market) {
        // Try matching by slug from trades
        const slug = trades[0]?.marketSlug;
        if (slug) market = marketBySlug.get(slug);
      }

      if (market) {
        // For single trader: require high volume (3+ trades)
        // For multiple traders: any agreement level is fine
        if (traders.length >= 2) {
          const yesTrades = trades.filter(t => t.side === 'YES').length;
          const noTrades = trades.filter(t => t.side === 'NO').length;
          const agreement = Math.max(yesTrades, noTrades) / trades.length;
          if (agreement >= 0.6) {
            convergent.push({ market, traders, recentTrades: trades });
          }
        } else if (trades.length >= 3) {
          // Single high-conviction trader with multiple bets
          convergent.push({ market, traders, recentTrades: trades });
        }
      }
    }

    // Sort by number of traders, then by number of trades
    return convergent.sort((a, b) => 
      b.traders.length - a.traders.length || b.recentTrades.length - a.recentTrades.length
    );
  }

  /**
   * Evaluate a single market opportunity
   */
  private evaluateOpportunity(
    market: MarketData,
    traders: TopTrader[],
    recentTrades: TradeRecord[],
    bankroll: number
  ): KellyBet | null {
    // Get current market price
    const currentPrice = market.outcomePrices[0]; // YES price

    // Calculate our probability estimate from top trader signals
    const signal = this.kelly.aggregateProbability(traders, market.id, currentPrice);
    if (!signal) return null;

    // Cross-reference with market fundamentals
    const fundamentalScore = this.scoreFundamentals(market);
    if (fundamentalScore < 0.2) return null; // Only skip very low-quality markets

    // Adjust probability by market quality
    const adjustedProb = signal.probability * 0.8 + fundamentalScore * 0.2;
    const marketPrice = signal.side === 'YES' ? currentPrice : (1 - currentPrice);

    // Calculate Kelly bet
    const kellyBet = this.kelly.calculateKellyBet(
      adjustedProb,
      marketPrice,
      bankroll,
      traders.map(t => t.wallet.address)
    );

    if (!kellyBet) return null;

    // Add market info
    kellyBet.market = market.id;
    kellyBet.side = signal.side;

    return kellyBet;
  }

  /**
   * Score market fundamentals:
   * - Liquidity (can we actually trade?)
   * - Volume (is it active?)
   * - Time to resolution (prefer nearer)
   */
  private scoreFundamentals(market: MarketData): number {
    let score = 0;

    // Liquidity score (0-1)
    const liquidityScore = Math.min(1, market.liquidity / 50000);
    score += liquidityScore * 0.4;

    // Volume score (0-1)
    const volumeScore = Math.min(1, market.volume / 100000);
    score += volumeScore * 0.3;

    // Time to resolution (prefer 1-14 days)
    const msToEnd = new Date(market.endDate).getTime() - Date.now();
    const daysToEnd = msToEnd / (24 * 60 * 60 * 1000);
    let timeScore = 0;
    if (daysToEnd >= 1 && daysToEnd <= 14) timeScore = 1;
    else if (daysToEnd > 14 && daysToEnd <= 30) timeScore = 0.7;
    else if (daysToEnd > 30) timeScore = 0.3;
    else timeScore = 0.5; // Very near resolution
    score += timeScore * 0.3;

    return score;
  }

  /**
   * Real-time market monitoring: detect sudden moves by top traders
   */
  async monitorRealtime(topTraders: TopTrader[]): Promise<TradeRecord[]> {
    const newTrades: TradeRecord[] = [];
    
    try {
      for (const trader of topTraders) {
        const response = await axios.get(`${this.apiUrl}/trades`, {
          params: {
            maker: trader.wallet.address,
            limit: 5,
          },
          timeout: 10000,
        });

        const trades: TradeRecord[] = response.data.map((t: any) => ({
          id: t.id,
          wallet: trader.wallet.address,
          market: t.market || t.condition_id,
          marketSlug: t.market_slug || '',
          outcome: t.outcome || '',
          side: t.side === 'BUY' ? 'YES' as const : 'NO' as const,
          amount: parseFloat(t.size || '0'),
          price: parseFloat(t.price || '0.5'),
          timestamp: new Date(t.timestamp || t.created_at).getTime(),
          resolved: false,
          won: null,
        }));

        // Filter for new trades (last 5 minutes)
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const fresh = trades.filter(t => t.timestamp > fiveMinAgo);
        newTrades.push(...fresh);
      }
    } catch (error) {
      logger.warn('Real-time monitoring error:', error);
    }

    return newTrades;
  }

  /**
   * Get market details by ID
   */
  async getMarket(marketId: string): Promise<MarketData | null> {
    if (this.marketsCache.has(marketId)) {
      return this.marketsCache.get(marketId)!;
    }

    try {
      const response = await axios.get(`${this.apiUrl}/markets/${marketId}`, {
        timeout: 10000,
      });
      const m = response.data;
      const market: MarketData = {
        id: m.condition_id || m.id,
        slug: m.slug || '',
        question: m.question || '',
        outcomes: m.outcomes || ['Yes', 'No'],
        outcomePrices: (m.outcomePrices || ['0.5', '0.5']).map(Number),
        volume: parseFloat(m.volume || '0'),
        liquidity: parseFloat(m.liquidity || '0'),
        endDate: m.end_date_iso || m.endDate || '',
        active: m.active !== false,
        category: m.category || 'general',
      };
      this.marketsCache.set(marketId, market);
      return market;
    } catch {
      return null;
    }
  }

  /**
   * Fetch all active markets from Polymarket Gamma API
   */
  private async fetchActiveMarkets(): Promise<MarketData[]> {
    try {
      const response = await axios.get(`${this.gammaUrl}/markets`, {
        params: { active: true, closed: false, limit: 100 },
        timeout: 30000,
      });

      return (response.data || []).map((m: any) => ({
        id: m.condition_id || m.clobTokenIds?.[0] || m.id,
        slug: m.slug || m.market_slug || '',
        question: m.question || '',
        outcomes: m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'],
        outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : [0.5, 0.5],
        volume: parseFloat(m.volume || m.volumeNum || '0'),
        liquidity: parseFloat(m.liquidity || m.liquidityNum || '0'),
        endDate: m.end_date_iso || m.endDate || m.end_date || '',
        active: m.active !== false,
        category: m.category || m.group_slug || 'general',
      }));
    } catch (error) {
      logger.error('Failed to fetch markets:', error);
      return [];
    }
  }
}
